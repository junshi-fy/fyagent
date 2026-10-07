import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error The release workflow executes this dependency-free helper directly.
import * as nsisContractModule from "../scripts/release/verify-windows-nsis-contract.mjs";

type VerificationResult = Readonly<{
  lifecyclePath: string | null;
  sectionOrder: string[];
  upstream: Readonly<{ tag: string; commit: string; sha256: string }>;
  workspaceVersion: string;
}>;

const ROOT = path.resolve(__dirname, "..");
const GIT_ATTRIBUTES = path.join(ROOT, ".gitattributes");
const BASE_CONFIG = path.join(ROOT, "src-tauri", "tauri.conf.json");
const WINDOWS_CONFIG = path.join(ROOT, "src-tauri", "tauri.windows.conf.json");
const TEMPLATE = path.join(ROOT, "src-tauri", "nsis", "installer.nsi");
const WEBVIEW_SOURCE = path.join(
  ROOT,
  "src-tauri",
  "nsis",
  "install-webview2-bootstrapper.ps1",
);
const WEBVIEW_LOADER = path.join(
  ROOT,
  "src-tauri",
  "nsis",
  "load-encoded-webview2-command.ps1",
);
const WEBVIEW_INCLUDE = path.join(
  ROOT,
  "src-tauri",
  "nsis",
  "webview2-command.nsh",
);
const LIFECYCLE = path.join(
  ROOT,
  "scripts",
  "release",
  "verify-windows-nsis-lifecycle.ps1",
);
const temporaryRoots: string[] = [];

const verifyWindowsNsisContract =
  nsisContractModule.verifyWindowsNsisContract as (options?: {
    baseConfigPath?: string;
    windowsConfigPath?: string;
    templatePath?: string;
    cargoManifestPath?: string;
    webviewSourcePath?: string;
    webviewLoaderPath?: string;
    webviewIncludePath?: string;
    lifecyclePath?: string;
  }) => VerificationResult;
const assertInstallPathPolicyContract =
  nsisContractModule.assertInstallPathPolicyContract as (
    source: string,
  ) => void;
const assertLifecycleContract = nsisContractModule.assertLifecycleContract as (
  source: string,
) => void;
const canonicalizeGzipHeader = nsisContractModule.canonicalizeGzipHeader as (
  compressed: Uint8Array,
) => Buffer;
const gzipDeterministically = nsisContractModule.gzipDeterministically as (
  payload: Uint8Array,
) => Buffer;

function temporaryFile(name: string, source: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fyagent-nsis-contract-"));
  temporaryRoots.push(root);
  const filePath = path.join(root, name);
  fs.writeFileSync(filePath, source);
  return filePath;
}

function powershellFunctionBlock(
  source: string,
  name: string,
  nextName: string,
): string {
  const start = source.indexOf(`function ${name} {`);
  const end = source.indexOf(`\nfunction ${nextName} {`, start + 1);
  if (start < 0 || end <= start) {
    throw new Error(`PowerShell function ${name} is missing or unterminated`);
  }
  return source.slice(start, end);
}

function powershellCaseBody(
  source: string,
  name: string,
  nextMarker: string,
): string {
  const marker = `  # CASE: ${name}\n`;
  const start = source.indexOf(marker);
  const end = source.indexOf(nextMarker, start + marker.length);
  if (start < 0 || end <= start) {
    throw new Error(`PowerShell case ${name} is missing or unterminated`);
  }
  return withoutPowerShellComments(
    source.slice(start + marker.length, end),
  ).trim();
}

function withoutPowerShellComments(source: string): string {
  return source.replace(/<#[\s\S]*?#>/gu, "").replace(/#[^\r\n]*/gu, "");
}

function powershellBraceDepthBetween(
  source: string,
  start: number,
  end: number,
): number {
  const executable = withoutPowerShellComments(source.slice(start, end));
  return [...executable].reduce((depth, character) => {
    if (character === "{") return depth + 1;
    if (character === "}") return depth - 1;
    return depth;
  }, 0);
}

function requireExecutableMarker(
  source: string,
  marker: string,
  description: string,
): void {
  if (!source.includes(marker)) {
    throw new Error(`native lifecycle is missing ${description}: ${marker}`);
  }
}

function assertBoundedLifecycleProcessContract(source: string): void {
  const executable = withoutPowerShellComments(source);
  if (/Start-Process[\s\S]{0,320}?\s-Wait\b/u.test(executable)) {
    throw new Error("native lifecycle must not use Start-Process -Wait");
  }
  if (/\.WaitForExit\(\s*\)/u.test(executable)) {
    throw new Error("native lifecycle contains an unbounded WaitForExit call");
  }

  for (const timeout of [
    "$nsisProcessTimeoutMilliseconds = 10 * 60 * 1000",
    "$cleanupNsisTimeoutMilliseconds = 2 * 60 * 1000",
    "$signatureVerifierTimeoutMilliseconds = 3 * 60 * 1000",
    "$nativeToolTimeoutMilliseconds = 2 * 60 * 1000",
    "$processRootExitAfterTreeKillTimeoutMilliseconds = 15 * 1000",
    "$redirectedOutputDrainTimeoutMilliseconds = 15 * 1000",
  ]) {
    requireExecutableMarker(executable, timeout, "bounded timeout");
  }

  const stopTree = powershellFunctionBlock(
    executable,
    "Stop-CaseOwnedProcessTree",
    "Receive-RedirectedProcessOutput",
  );
  for (const marker of [
    "$Process.Kill($true)",
    "$Process.WaitForExit($processRootExitAfterTreeKillTimeoutMilliseconds)",
    "root-already-exited-before-tree-kill",
    "tree-kill-issued-root-still-running-after-",
    "tree-kill-issued-root-exited",
  ]) {
    requireExecutableMarker(stopTree, marker, "process-tree kill behavior");
  }
  if (stopTree.includes("return 'terminated'")) {
    throw new Error(
      "process-tree diagnostics must not claim descendant termination",
    );
  }

  const receiveOutput = powershellFunctionBlock(
    executable,
    "Receive-RedirectedProcessOutput",
    "Get-CapturedProcessOutputFailureDetail",
  );
  const waitAll = receiveOutput.indexOf("[Threading.Tasks.Task]::WaitAll(");
  const firstGetResult = receiveOutput.indexOf(".GetAwaiter().GetResult()");
  if (waitAll < 0 || firstGetResult <= waitAll) {
    throw new Error(
      "native lifecycle may read redirected output only after bounded Task.WaitAll",
    );
  }
  if (
    (receiveOutput.match(/\.GetAwaiter\(\)\.GetResult\(\)/gu) ?? []).length !==
    2
  ) {
    throw new Error("bounded output drain must collect both completed streams");
  }
  for (const marker of [
    "$StandardOutputTask.Status -eq [Threading.Tasks.TaskStatus]::RanToCompletion",
    "$StandardErrorTask.Status -eq [Threading.Tasks.TaskStatus]::RanToCompletion",
    "StandardOutput = $standardOutput",
    "StandardError = $standardError",
  ]) {
    requireExecutableMarker(
      receiveOutput,
      marker,
      "completed redirected stream salvage",
    );
  }

  const outputDetail = powershellFunctionBlock(
    executable,
    "Get-CapturedProcessOutputFailureDetail",
    "Invoke-BoundedCaseProcess",
  );
  for (const marker of [
    '"stdout=$($StandardOutput.TrimEnd())"',
    '"stderr=$($StandardError.TrimEnd())"',
    "return '; captured-output-formatting-failed'",
  ]) {
    requireExecutableMarker(
      outputDetail,
      marker,
      "non-masking captured output diagnostics",
    );
  }

  const boundedProcess = powershellFunctionBlock(
    executable,
    "Invoke-BoundedCaseProcess",
    "Get-Registry64Value",
  );
  if ((boundedProcess.match(/ReadToEndAsync\(\)/gu) ?? []).length !== 2) {
    throw new Error(
      "native lifecycle must asynchronously drain both stdout and stderr",
    );
  }
  const stdoutDrainStart = boundedProcess.indexOf(
    "$standardOutputTask = $process.StandardOutput.ReadToEndAsync()",
  );
  const stderrDrainStart = boundedProcess.indexOf(
    "$standardErrorTask = $process.StandardError.ReadToEndAsync()",
  );
  const processWait = boundedProcess.indexOf(
    "$process.WaitForExit($TimeoutMilliseconds)",
  );
  if (
    stdoutDrainStart < 0 ||
    stderrDrainStart < 0 ||
    processWait <= stdoutDrainStart ||
    processWait <= stderrDrainStart
  ) {
    throw new Error(
      "native lifecycle must begin draining both redirected streams before waiting",
    );
  }
  for (const marker of [
    "$process.WaitForExit($TimeoutMilliseconds)",
    "Stop-CaseOwnedProcessTree -Process $process -CaseName $CaseName",
    "$outcome = 'timed-out'",
    "$outcome = 'unexpected-exit'",
    "$outcome = 'output-drain-failed'",
    "$outcome = 'dispose-failed'",
    "CASE START name={0} utc={1} pid={2} timeoutMs={3}",
    "CASE END name={0} utc={1} pid={2} elapsedMs={3} exitCode={4} outcome={5}",
    "throw $operationFailure",
  ]) {
    requireExecutableMarker(boundedProcess, marker, "bounded process behavior");
  }
  if ((boundedProcess.match(/\$process\.Dispose\(\)/gu) ?? []).length !== 1) {
    throw new Error("native lifecycle must dispose every owned Process handle");
  }
  requireExecutableMarker(
    boundedProcess,
    "try {\n      $process.Dispose()\n    } catch {",
    "non-masking process disposal",
  );
  if (
    (boundedProcess.match(/Get-CapturedProcessOutputFailureDetail/gu) ?? [])
      .length !== 3
  ) {
    throw new Error(
      "timeout, output-drain, and unexpected-exit failures must retain captured output",
    );
  }
  if (
    (boundedProcess.match(/\$standardOutput = \$drain\.StandardOutput/gu) ?? [])
      .length !== 2 ||
    (boundedProcess.match(/\$standardError = \$drain\.StandardError/gu) ?? [])
      .length !== 2
  ) {
    throw new Error(
      "timeout and completed-process drain paths must retain both captured streams",
    );
  }
  const finalStdoutAssignment = boundedProcess.lastIndexOf(
    "$standardOutput = $drain.StandardOutput",
  );
  const finalStderrAssignment = boundedProcess.lastIndexOf(
    "$standardError = $drain.StandardError",
  );
  const drainFailureCheck = boundedProcess.lastIndexOf(
    "if (-not $drain.Completed)",
  );
  if (
    finalStdoutAssignment < 0 ||
    finalStderrAssignment < 0 ||
    drainFailureCheck <= finalStdoutAssignment ||
    drainFailureCheck <= finalStderrAssignment
  ) {
    throw new Error(
      "completed redirected streams must be retained before reporting drain failure",
    );
  }

  const nsisProcess = powershellFunctionBlock(
    executable,
    "Invoke-NsisProcess",
    "Invoke-NsisUninstall",
  );
  for (const marker of [
    "[ValidateSet('Install', 'Uninstall')]",
    "$ArgumentKind -ceq 'Install'",
    "$ArgumentKind -ceq 'Uninstall'",
    "$Arguments.Count -eq 1 -or $Arguments.Count -eq 2",
    "$Arguments[0] -ceq '/S'",
    "$Arguments[1].Length -gt 3 -and\n        $Arguments[1].StartsWith('/D=', [StringComparison]::Ordinal)",
    "$Arguments[1].Length -gt 3 -and\n    $Arguments[1].StartsWith('_?=', [StringComparison]::Ordinal)",
    "$argument.Contains([char]34)",
    "foreach ($character in $argument.ToCharArray())",
    "[char]::IsControl($character)",
    "$startInfo.Arguments = [string]::Join(' ', $Arguments)",
    "-ExpectedExit $expectedExit",
  ]) {
    requireExecutableMarker(
      nsisProcess,
      marker,
      "NSIS process launch contract",
    );
  }
  if (nsisProcess.includes("ArgumentList.Add")) {
    throw new Error("NSIS /D= launch must preserve its unquoted raw syntax");
  }
  const controlValidation = nsisProcess.indexOf(
    "[char]::IsControl($character)",
  );
  const rawArguments = nsisProcess.indexOf(
    "$startInfo.Arguments = [string]::Join(' ', $Arguments)",
  );
  const caseLog = nsisProcess.indexOf(
    "Write-Host \"CASE ${CaseName}: $FilePath $($Arguments -join ' ')\"",
  );
  if (
    controlValidation < 0 ||
    rawArguments <= controlValidation ||
    caseLog <= rawArguments
  ) {
    throw new Error(
      "NSIS arguments must be validated before raw transport or logging",
    );
  }

  const uninstall = powershellFunctionBlock(
    executable,
    "Invoke-NsisUninstall",
    "Invoke-BestEffortNsisUninstall",
  );
  for (const marker of [
    "$sourceUninstaller = [IO.Path]::GetFullPath(",
    "(Join-Path $InstallDirectory 'uninstall.exe')",
    "$resolvedWorkingDirectory = (Resolve-Path -LiteralPath $WorkingDirectory).Path",
    "$copyRoot = [IO.Path]::GetFullPath(",
    "'nsis-uninstall-' + [Guid]::NewGuid().ToString('N')",
    "$copyRootInfo.Parent.FullName",
    "$workingDirectoryInfo.FullName",
    "$copiedUninstaller = [IO.Path]::GetFullPath(",
    "[IO.Path]::GetDirectoryName($copiedUninstaller)",
    "[IO.File]::Copy($sourceUninstaller, $copiedUninstaller, $false)",
    "-FilePath $copiedUninstaller",
    "-Arguments @('/S', \"_?=$InstallDirectory\")",
    "-ArgumentKind Uninstall",
    "Remove-Item -LiteralPath $copiedUninstaller -Force -ErrorAction Stop",
    "Remove-Item -LiteralPath $copyRoot -Force -ErrorAction Stop",
    "throw $operationFailure",
    "case-local uninstaller cleanup also failed",
    "case-local uninstaller cleanup failed",
  ]) {
    requireExecutableMarker(
      uninstall,
      marker,
      "NSIS uninstall execution contract",
    );
  }
  if (uninstall.includes("-Arguments @('/S')")) {
    throw new Error("NSIS uninstall must never fall back to a bare /S launch");
  }
  const copyUninstaller = uninstall.indexOf(
    "[IO.File]::Copy($sourceUninstaller, $copiedUninstaller, $false)",
  );
  const invokeCopiedUninstaller = uninstall.indexOf(
    "-FilePath $copiedUninstaller",
  );
  const removeCopiedUninstaller = uninstall.indexOf(
    "Remove-Item -LiteralPath $copiedUninstaller -Force -ErrorAction Stop",
  );
  const removeCopyRoot = uninstall.indexOf(
    "Remove-Item -LiteralPath $copyRoot -Force -ErrorAction Stop",
  );
  if (
    copyUninstaller < 0 ||
    invokeCopiedUninstaller <= copyUninstaller ||
    removeCopiedUninstaller <= invokeCopiedUninstaller ||
    removeCopyRoot <= removeCopiedUninstaller
  ) {
    throw new Error(
      "NSIS uninstall must copy, execute, then remove its case-local uninstaller",
    );
  }
  if (uninstall.includes("Remove-Item -LiteralPath $copyRoot -Recurse")) {
    throw new Error(
      "NSIS uninstall cleanup must never recursively widen beyond its copied file",
    );
  }

  const cleanup = powershellFunctionBlock(
    executable,
    "Invoke-BestEffortNsisUninstall",
    "Get-OwnerDaclSddl",
  );
  for (const marker of [
    "try {\n    $uninstaller = Join-Path $InstallDirectory 'uninstall.exe'",
    "Invoke-NsisUninstall `",
    "-TimeoutMilliseconds $cleanupNsisTimeoutMilliseconds",
    'Write-Warning "Cleanup ${CaseName} failed: $($_.Exception.Message)"',
  ]) {
    requireExecutableMarker(cleanup, marker, "best-effort cleanup isolation");
  }
  if (
    cleanup.includes("Invoke-NsisProcess") ||
    cleanup.includes("-Arguments @('/S')")
  ) {
    throw new Error(
      "best-effort cleanup must share the case-local NSIS uninstall path",
    );
  }

  const mainTryMarker = "$sentinelParentsCreatedByTest = @{}\n\ntry {";
  const mainTryMarkerIndex = source.indexOf(mainTryMarker);
  const mainTryStart = source.indexOf("try {", mainTryMarkerIndex);
  if (mainTryMarkerIndex < 0 || mainTryStart < 0) {
    throw new Error("native lifecycle main try block is missing");
  }
  for (const caseName of [
    "default-uninstall-user-data-preservation",
    "custom-uninstall-user-data-preservation",
  ]) {
    const caseMarker = `  # CASE: ${caseName}\n`;
    const caseMarkerIndex = source.indexOf(caseMarker, mainTryStart);
    const helperIndex = source.indexOf(
      "Invoke-NsisUninstall `",
      caseMarkerIndex + caseMarker.length,
    );
    if (
      caseMarkerIndex < 0 ||
      helperIndex < 0 ||
      powershellBraceDepthBetween(source, mainTryStart, caseMarkerIndex) !==
        1 ||
      powershellBraceDepthBetween(source, mainTryStart, helperIndex) !== 1
    ) {
      throw new Error(
        "ordinary uninstall helpers must be direct statements in the main lifecycle try block",
      );
    }
  }

  for (const [actual, expected] of [
    [
      powershellCaseBody(
        source,
        "default-uninstall-user-data-preservation",
        "  # CASE: preexisting-runtime-extra-ace-negative",
      ),
      `Invoke-NsisUninstall \`
    -InstallDirectory $defaultInstallDir \`
    -CaseName 'default-uninstall-user-data-preservation' \`
    -WorkingDirectory $testRoot
  Assert-UninstalledState -InstallDirectory $defaultInstallDir -UserSentinels $userSentinels`,
    ],
    [
      powershellCaseBody(
        source,
        "custom-uninstall-user-data-preservation",
        '  Write-Host "Windows NSIS native lifecycle verified for $Architecture."',
      ),
      `Invoke-NsisUninstall \`
    -InstallDirectory $customInstallDir \`
    -CaseName 'custom-uninstall-user-data-preservation' \`
    -WorkingDirectory $testRoot
  Assert-UninstalledState -InstallDirectory $customInstallDir -UserSentinels $userSentinels`,
    ],
  ] as const) {
    if (actual !== expected) {
      throw new Error(
        "ordinary uninstall cases must contain only the shared uninstall helper followed by their state assertion",
      );
    }
  }
  if (
    (executable.match(/Invoke-NsisUninstall `$/gmu) ?? []).length !== 3 ||
    executable.includes("$defaultUninstaller") ||
    executable.includes("$customUninstaller")
  ) {
    throw new Error(
      "every ordinary and cleanup uninstall must use the shared case-local helper",
    );
  }

  const signatureVerifier = powershellFunctionBlock(
    executable,
    "Invoke-WebView2SignatureVerification",
    "Save-OfficialWebView2BootstrapperFixture",
  );
  const nativeTool = powershellFunctionBlock(
    executable,
    "Invoke-NativeTool",
    "Invoke-FakeCurrentUserRootAttackFixture",
  );
  for (const [block, expectedExit] of [
    [signatureVerifier, "-ExpectedExit $expectedExit"],
    [nativeTool, "-ExpectedExit Zero"],
  ] as const) {
    requireExecutableMarker(
      block,
      "$startInfo.RedirectStandardOutput = $true",
      "stdout redirect",
    );
    requireExecutableMarker(
      block,
      "$startInfo.RedirectStandardError = $true",
      "stderr redirect",
    );
    requireExecutableMarker(
      block,
      "[void]$startInfo.ArgumentList.Add($argument)",
      "lossless helper argument transport",
    );
    requireExecutableMarker(block, expectedExit, "helper exit expectation");
  }
  if (
    (
      executable.match(
        /\[void\]\$startInfo\.ArgumentList\.Add\(\$argument\)/gu,
      ) ?? []
    ).length !== 2
  ) {
    throw new Error(
      "only the PowerShell verifier and native tool may use ArgumentList",
    );
  }
}

function verifyTemplate(source: string): VerificationResult {
  return verifyWindowsNsisContract({
    baseConfigPath: BASE_CONFIG,
    windowsConfigPath: WINDOWS_CONFIG,
    templatePath: temporaryFile("installer.nsi", source),
  });
}

function encodedIncludeForSource(source: string): string {
  const include = fs.readFileSync(WEBVIEW_INCLUDE, "utf8");
  const encoded = gzipDeterministically(
    Buffer.from(source, "utf16le"),
  ).toString("base64");
  const chunks = encoded.match(/.{1,768}/gu) ?? [];
  const declaredCount = Number.parseInt(
    include.match(/FYAGENT_WEBVIEW2_COMMAND_CHUNK_COUNT (\d+)/u)?.[1] ?? "0",
    10,
  );
  expect(chunks).toHaveLength(declaredCount);
  let updated = include;
  for (let index = 0; index < chunks.length; index += 1) {
    const suffix = String(index).padStart(2, "0");
    updated = updated.replace(
      new RegExp(
        `(!define FYAGENT_WEBVIEW2_COMMAND_${suffix} ")[^"]+("$)`,
        "mu",
      ),
      `$1${chunks[index]}$2`,
    );
  }
  return updated;
}

function padWebViewSourceToDeclaredChunkCount(source: string): string {
  const include = fs.readFileSync(WEBVIEW_INCLUDE, "utf8");
  const declaredCount = Number.parseInt(
    include.match(/FYAGENT_WEBVIEW2_COMMAND_CHUNK_COUNT (\d+)/u)?.[1] ?? "0",
    10,
  );
  let candidate = `${source.trimEnd()}\n# Contract mutation padding: `;
  let state = 0x5f37_59df;
  for (let index = 0; index < 4096; index += 1) {
    const chunkCount = Math.ceil(
      gzipDeterministically(Buffer.from(candidate, "utf16le")).toString(
        "base64",
      ).length / 768,
    );
    if (chunkCount === declaredCount) return `${candidate}\n`;
    expect(chunkCount).toBeLessThan(declaredCount);
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    candidate += "abcdefghijklmnopqrstuvwxyz0123456789"[state % 36];
  }
  throw new Error(
    "unable to pad mutated WebView2 source to the declared chunk count",
  );
}

function encodedIncludeForLoader(loader: string): string {
  return fs
    .readFileSync(WEBVIEW_INCLUDE, "utf8")
    .replace(
      /(^!define FYAGENT_WEBVIEW2_LOADER_BASE64 ")[A-Za-z0-9+/=]+("$)/mu,
      `$1${Buffer.from(loader, "utf16le").toString("base64")}$2`,
    );
}

afterAll(() => {
  for (const root of temporaryRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Windows NSIS installer contract", () => {
  it("pins Tauri 2.8.1 and validates the packaging contract", () => {
    const result = verifyWindowsNsisContract();
    expect(result.upstream).toEqual({
      tag: "tauri-cli-v2.8.1",
      commit: "662b39adb33d1d26f0de213e5a04fc4116fd0683",
      sha256:
        "fe22026f68bdb3292fab376756035496ce0a35e3d580e06ebaa6a28295916eb3",
    });
    expect(result.lifecyclePath).toBeNull();
    expect(result.sectionOrder).toEqual([
      "EarlyChecks",
      "WebView2",
      "Install",
      "Uninstall",
    ]);
  });

  it("keeps manual lifecycle diagnostics outside the packaging verifier", () => {
    const lifecycle = fs.readFileSync(LIFECYCLE, "utf8");
    expect(() => assertLifecycleContract(lifecycle)).not.toThrow();
    const result = verifyWindowsNsisContract({ lifecyclePath: LIFECYCLE });
    expect(result.lifecyclePath).toBe(path.resolve(LIFECYCLE));
  });

  it.each([
    "CASE: relative-path-negative",
    "CASE: unc-network-negative",
    "CASE: access-denied-ancestor-negative",
    "CASE: reparse-network-negative",
    "CASE: unsupported-drive-network-negative",
    "CASE: reparse-unsupported-drive-network-negative",
    "FyAgent.NsisLifecycle.NativeNetworkDrive",
    "Invoke-RequiredUnsupportedDriveAcceptance",
    "SmbShare\\New-SmbShare",
    "Assert-RejectedInstallLeftNoMachineWrites",
    "before its final path was admitted",
  ])("rejects retired manual path-policy token %s", (retiredToken) => {
    const lifecycle = fs.readFileSync(LIFECYCLE, "utf8");
    const restrictedLifecycle = `${retiredToken}\n${lifecycle}`;
    expect(() => assertLifecycleContract(restrictedLifecycle)).toThrow(
      /must not enforce the retired installation-path restriction/u,
    );
  });

  it("does not impose a custom installation-path admission policy", () => {
    const source = fs.readFileSync(TEMPLATE, "utf8");
    expect(() => assertInstallPathPolicyContract(source)).not.toThrow();
    const unrelatedFinishCallback = source.replace(
      "!insertmacro MUI_PAGE_FINISH",
      "!define MUI_PAGE_CUSTOMFUNCTION_LEAVE PageLeaveReinstall\n!insertmacro MUI_PAGE_FINISH",
    );
    expect(() =>
      assertInstallPathPolicyContract(unrelatedFinishCallback),
    ).not.toThrow();
    for (const mutation of [
      source.replace(
        "!insertmacro MUI_PAGE_DIRECTORY",
        "!define MUI_PAGE_CUSTOMFUNCTION_LEAVE RestrictInstallPath\n!insertmacro MUI_PAGE_DIRECTORY",
      ),
      source.replace(
        "!define FYAGENT_FILE_ATTRIBUTE_DIRECTORY",
        "!define FYAGENT_DRIVE_FIXED 3\n!define FYAGENT_FILE_ATTRIBUTE_DIRECTORY",
      ),
      source.replace(
        "Section EarlyChecks",
        'Section EarlyChecks\n  StrCmp $INSTDIR "C:\\\\Allowed" +2\n  Abort',
      ),
      source.replace(
        "Section EarlyChecks",
        "Section -RenamedInstallPathCheck\n  Abort\nSectionEnd\n\nSection EarlyChecks",
      ),
    ]) {
      expect(() => verifyTemplate(mutation)).toThrow(
        /must not (?:add|bind|reintroduce|use)/u,
      );
    }
  });

  it("checks the executed repo-owned NSIS hook closure for install-path gates", () => {
    const include = fs.readFileSync(WEBVIEW_INCLUDE, "utf8");
    const gatedHook = [
      include.trimEnd(),
      "!macro NSIS_HOOK_PREINSTALL",
      '  StrCmp $INSTDIR "C:\\Program Files\\FyAgent" +2',
      "  Abort",
      "!macroend",
      "",
    ].join("\n");
    const includePath = temporaryFile("webview2-command.nsh", gatedHook);

    expect(() =>
      verifyWindowsNsisContract({
        baseConfigPath: BASE_CONFIG,
        windowsConfigPath: WINDOWS_CONFIG,
        templatePath: TEMPLATE,
        webviewIncludePath: includePath,
      }),
    ).toThrow(
      /repo-owned NSIS include\/hook must not inspect or rewrite \$INSTDIR/u,
    );
  });

  it("rejects a maintenance path gate through the registry path alias", () => {
    const source = fs.readFileSync(TEMPLATE, "utf8");
    const gatedRegistryAlias = source.replace(
      '    ReadRegStr $4 SHCTX "${MANUPRODUCTKEY}" ""',
      `    ReadRegStr $4 SHCTX "\${MANUPRODUCTKEY}" ""
    StrCmp $4 "C:\\Program Files\\FyAgent" +2
    Abort`,
    );
    expect(gatedRegistryAlias).not.toBe(source);
    expect(() => verifyTemplate(gatedRegistryAlias)).toThrow(
      /maintenance registry install-path alias \$4/u,
    );
  });

  it("pins maintenance install-location restoration to an exact pass-through", () => {
    const source = fs.readFileSync(TEMPLATE, "utf8");
    const aliasedRestoreGate = source.replace(
      '  ${If} $4 != ""\n    StrCpy $INSTDIR $4',
      `  \${If} $4 != ""
    StrCpy $5 $4
    StrCmp $5 "C:\\Program Files\\FyAgent" +2 0
      Abort
    StrCpy $INSTDIR $4`,
    );
    expect(aliasedRestoreGate).not.toBe(source);
    expect(() => verifyTemplate(aliasedRestoreGate)).toThrow(
      /RestorePreviousInstallLocation must prefer the current NSIS path/u,
    );
  });

  it("rejects a newly named manual install-path rejection case", () => {
    const lifecycle = fs.readFileSync(LIFECYCLE, "utf8");
    const restrictedLifecycle = lifecycle.replace(
      "  # CASE: default-install",
      `  # CASE: renamed-path-rejection
  [void](Invoke-NsisProcess -FilePath $resolvedInstaller -Arguments @('/S', "/D=$customInstallDir") -ShouldSucceed $false -CaseName 'renamed-path-rejection' -WorkingDirectory $testRoot)

  # CASE: default-install`,
    );
    expect(restrictedLifecycle).not.toBe(lifecycle);
    expect(() => assertLifecycleContract(restrictedLifecycle)).toThrow(
      /resolved-installer invocation set drifted/u,
    );
  });

  it("rejects a new resolved-installer case with a variable expected outcome", () => {
    const lifecycle = fs.readFileSync(LIFECYCLE, "utf8");
    const mutated = lifecycle.replace(
      "  # CASE: default-install",
      `  $newInstallerCaseShouldSucceed = $false
  [void](Invoke-NsisProcess -FilePath $resolvedInstaller -Arguments @('/S') -ShouldSucceed $newInstallerCaseShouldSucceed -CaseName 'renamed-runtime-negative' -WorkingDirectory $testRoot)

  # CASE: default-install`,
    );
    expect(mutated).not.toBe(lifecycle);
    expect(() => assertLifecycleContract(mutated)).toThrow(
      /resolved-installer invocation set drifted/u,
    );
  });

  it("rejects an aliased installer invocation regardless of PowerShell command casing", () => {
    const lifecycle = fs.readFileSync(LIFECYCLE, "utf8");
    for (const commandName of ["Invoke-NsisProcess", "invoke-nsisprocess"]) {
      const mutated = lifecycle.replace(
        "  # CASE: default-install",
        `  $aliasedInstaller = $resolvedInstaller
  [void](${commandName} -FilePath $aliasedInstaller -Arguments @('/S') -ShouldSucceed $true -CaseName 'aliased-installer' -WorkingDirectory $testRoot)

  # CASE: default-install`,
      );
      expect(mutated).not.toBe(lifecycle);
      expect(() => assertLifecycleContract(mutated)).toThrow(
        /Invoke-NsisProcess invocation set drifted/u,
      );
    }
  });

  it("pins every approved resolved-installer case, argument list, and outcome", () => {
    const lifecycle = fs.readFileSync(LIFECYCLE, "utf8");
    const defaultCall =
      "[void](Invoke-NsisProcess -FilePath $resolvedInstaller -Arguments @('/S') -ShouldSucceed $true -CaseName 'default-install' -WorkingDirectory $testRoot)";
    for (const replacement of [
      "[void](Invoke-NsisProcess -FilePath $resolvedInstaller -Arguments @('/S', \"/D=$customInstallDir\") -ShouldSucceed $true -CaseName 'default-install' -WorkingDirectory $testRoot)",
      "[void](Invoke-NsisProcess -FilePath $resolvedInstaller -Arguments @('/S') -ShouldSucceed $false -CaseName 'default-install' -WorkingDirectory $testRoot)",
      "[void](Invoke-NsisProcess -FilePath $resolvedInstaller -Arguments @('/S') -ShouldSucceed $true -CaseName 'renamed-default-install' -WorkingDirectory $testRoot)",
    ]) {
      const mutated = lifecycle.replace(defaultCall, replacement);
      expect(mutated).not.toBe(lifecycle);
      expect(() => assertLifecycleContract(mutated)).toThrow(
        /unexpected (?:or duplicate resolved-installer case|arguments or outcome)/u,
      );
    }
  });

  it("ignores unrelated WebView negative outcomes when admitting installer calls", () => {
    const lifecycle = fs.readFileSync(LIFECYCLE, "utf8");
    const extraWebViewNegative = lifecycle.replace(
      "  # CASE: default-install",
      `  # CASE: webview2-extra-diagnostic-negative
  Invoke-WebView2SignatureVerification \`
    -HelperPath $webView2Helper \`
    -CandidatePath $tamperedCandidate \`
    -MaliciousModuleRoot $maliciousModuleRoot \`
    -MarkerPath $maliciousMarker \`
    -ShouldSucceed $false \`
    -CaseName 'webview2-extra-diagnostic-negative'

  # CASE: default-install`,
    );
    expect(extraWebViewNegative).not.toBe(lifecycle);
    expect(() => assertLifecycleContract(extraWebViewNegative)).not.toThrow();
  });

  it("pins the canonical FyAgent icon for installer and uninstaller", () => {
    const source = fs.readFileSync(TEMPLATE, "utf8");
    for (const mutation of [
      source.replace('  !define MUI_UNICON "${INSTALLERICON}"\n', ""),
      source.replace(
        '  !define MUI_ICON "${INSTALLERICON}"',
        '  !define MUI_ICON "${INSTALLERICON}"\n  !undef MUI_ICON',
      ),
      source.replace(
        '  !define MUI_UNICON "${INSTALLERICON}"',
        '  !define MUI_UNICON "${INSTALLERICON}"\n  !define /redef MUI_UNICON "other.ico"',
      ),
      source.replace(
        '  !define MUI_ICON "${INSTALLERICON}"',
        '  !define MUI_ICON "${INSTALLERICON}"\n  !define MUI_ICON "${INSTALLERICON}"',
      ),
    ]) {
      expect(mutation).not.toBe(source);
      expect(() => verifyTemplate(mutation)).toThrow(
        /exactly one canonical FyAgent icon definition/u,
      );
    }

    const includeOverride = `${fs.readFileSync(WEBVIEW_INCLUDE, "utf8").trimEnd()}\n!define MUI_ICON "other.ico"\n`;
    expect(() =>
      verifyWindowsNsisContract({
        baseConfigPath: BASE_CONFIG,
        windowsConfigPath: WINDOWS_CONFIG,
        templatePath: TEMPLATE,
        webviewIncludePath: temporaryFile(
          "webview2-command.nsh",
          includeOverride,
        ),
      }),
    ).toThrow(/exactly one canonical FyAgent icon definition/u);
  });

  it("keeps warning 6000 fatal across the repo-owned NSIS closure", () => {
    const source = fs.readFileSync(TEMPLATE, "utf8");
    for (const mutation of [
      source.replace("!pragma warning error 6000\n", ""),
      source.replace(
        "!pragma warning error 6000",
        "!pragma warning disable 6000",
      ),
      `${source}\n!pragma warning disable 6000\n`,
      `${source}\n!pragma warning warning 6000\n`,
      `${source}\n!pragma warning default 6000\n`,
      `${source}\n!pragma warning enable 6000\n`,
      `${source}\n!pragma warning disable all\n`,
      `${source}\n!pragma warning warning all\n`,
      `${source}\n!pragma warning default all\n`,
      `${source}\n!pragma warning enable all\n`,
      `${source}\n!define FYAGENT_WARNING_PRAGMA warning\n!pragma \${FYAGENT_WARNING_PRAGMA} disable 6000\n`,
      source
        .replace(
          "!pragma warning error 6000",
          "!pragma warning push\n!pragma warning error 6000",
        )
        .concat("\n!pragma warning pop\n"),
      `${source}\n!pragma warning push\n!pragma warning disable all\n!pragma warning pop\n`,
    ]) {
      expect(mutation).not.toBe(source);
      expect(() => verifyTemplate(mutation)).toThrow(
        /warning 6000 (?:protection must be the canonical top-level template directive|must remain an error)/u,
      );
    }

    const includeOverride = `${fs.readFileSync(WEBVIEW_INCLUDE, "utf8").trimEnd()}\n!pragma warning disable 6000\n`;
    expect(() =>
      verifyWindowsNsisContract({
        baseConfigPath: BASE_CONFIG,
        windowsConfigPath: WINDOWS_CONFIG,
        templatePath: TEMPLATE,
        webviewIncludePath: temporaryFile(
          "webview2-command.nsh",
          includeOverride,
        ),
      }),
    ).toThrow(/NSIS warning 6000 must remain an error/u);
  });

  it("rejects dynamically expanded preprocessor directive names", () => {
    const source = fs.readFileSync(TEMPLATE, "utf8");
    const hookInclude = '!include "{{installer_hooks}}"';
    const hookBlock = `{{#if installer_hooks}}\n${hookInclude}\n{{/if}}`;
    for (const mutation of [
      `${source}\n!define FYAGENT_DIRECTIVE pragma\n!\${FYAGENT_DIRECTIVE} warning disable 6000\n`,
      source.replace(
        hookBlock,
        [
          "!define FYAGENT_IF if",
          "!define FYAGENT_ENDIF endif",
          "{{#if installer_hooks}}",
          "!\${FYAGENT_IF} 0",
          hookInclude,
          "!\${FYAGENT_ENDIF}",
          "{{/if}}",
        ].join("\n"),
      ),
    ]) {
      expect(mutation).not.toBe(source);
      expect(() => verifyTemplate(mutation)).toThrow(
        /dynamic NSIS preprocessor directive names are forbidden/u,
      );
    }
  });

  it("allows only reviewed runtime macros at line start", () => {
    const source = fs.readFileSync(TEMPLATE, "utf8");
    const hookInclude = '!include "{{installer_hooks}}"';
    const hookBlock = `{{#if installer_hooks}}\n${hookInclude}\n{{/if}}`;
    const nsisQuotes = ['"', "'", "`"];
    for (const mutation of [
      `${source}\n!define B !\n\${B}pragma warning disable 6000\n`,
      source.replace(
        hookBlock,
        [
          "!define B !",
          "{{#if installer_hooks}}",
          "\${B}if 0",
          hookInclude,
          "\${B}endif",
          "{{/if}}",
        ].join("\n"),
      ),
    ]) {
      expect(mutation).not.toBe(source);
      expect(() => verifyTemplate(mutation)).toThrow(
        /only reviewed runtime macros may appear at line start/u,
      );
    }

    for (const mutation of [
      `${source}\n!define /redef If !pragma warning disable 6000\n`,
      `${source}\n!macroundef If\n!macro If\n!macroend\n`,
      `${source}\n!define B If\n!define \${B} !pragma warning disable 6000\n`,
      ...nsisQuotes.map(
        (quote) =>
          `${source}\n!define /redef ${quote}If${quote} !\n\${If}pragma warning disable 6000\n`,
      ),
      ...nsisQuotes.map(
        (quote) =>
          `${source}\n!define ${quote}/redef${quote} If !\n\${If}pragma warning disable 6000\n`,
      ),
      `${source}\n!define B If\n!define /redef "\${B}" !\n\${If}pragma warning disable 6000\n`,
      `${source}\n!define /redef "If !\n\${If}pragma warning disable 6000\n`,
      `${source}\n!macroundef If\n!macro "If"\n!macroend\n`,
    ]) {
      expect(mutation).not.toBe(source);
      expect(() => verifyTemplate(mutation)).toThrow(
        /must use literal unquoted names and must not redefine reviewed line-start runtime macro names/u,
      );
    }
  });

  it("pins the warning pragma and installer hook to active top-level positions", () => {
    const source = fs.readFileSync(TEMPLATE, "utf8");
    const canonicalDirective = "!pragma warning error 6000";
    const hookInclude = '!include "{{installer_hooks}}"';
    const hookBlock = `{{#if installer_hooks}}\n${hookInclude}\n{{/if}}`;
    for (const mutation of [
      source.replace(
        canonicalDirective,
        `!if 0\n${canonicalDirective}\n!endif`,
      ),
      source.replace(
        hookBlock,
        `{{#if installer_hooks}}\n!if 0\n${hookInclude}\n!endif\n{{/if}}`,
      ),
      source
        .replace(canonicalDirective, `${hookInclude}\n${canonicalDirective}`)
        .replace(
          hookBlock,
          `{{#if installer_hooks}}\n!if 0\n${hookInclude}\n!endif\n{{/if}}`,
        ),
    ]) {
      expect(mutation).not.toBe(source);
      expect(() => verifyTemplate(mutation)).toThrow(
        /canonical top-level template directive|installer hook include must appear exactly once at top level/u,
      );
    }
  });

  it("ignores preprocessor directive text in NSIS comments and strings", () => {
    const source = `${fs.readFileSync(TEMPLATE, "utf8").trimEnd()}
; !pragma warning disable 6000
# !pragma warning default all
/*
!pragma \${FYAGENT_WARNING_PRAGMA} disable 6000
!\${FYAGENT_DIRECTIVE} warning disable 6000
\${B}pragma warning disable 6000
*/
!define FYAGENT_WARNING_TEXT "!pragma warning warning 6000"
!define FYAGENT_DYNAMIC_PRAGMA_TEXT "!pragma \${FYAGENT_WARNING_PRAGMA} disable 6000"
!define FYAGENT_DYNAMIC_DIRECTIVE_TEXT "!\${FYAGENT_DIRECTIVE} warning disable 6000"
!define FYAGENT_LINE_START_TEXT "\${B}pragma warning disable 6000"
`;

    expect(() => verifyTemplate(source)).not.toThrow();
  });

  it("pins the native Common ProgramData token and per-machine contexts", () => {
    const source = fs.readFileSync(TEMPLATE, "utf8");
    for (const mutation of [
      source.replace("$COMMONPROGRAMDATA\\FyAgent", "$COMMONAPPDATA\\FyAgent"),
      source.replace("$COMMONPROGRAMDATA\\FyAgent", "$APPDATA\\FyAgent"),
    ]) {
      expect(mutation).not.toBe(source);
      expect(() => verifyTemplate(mutation)).toThrow(
        /exact NSIS \$COMMONPROGRAMDATA|unknown \$COMMONAPPDATA/u,
      );
    }

    for (const mutation of [
      source.replace(
        "  !insertmacro SetContext\n\n  ; Capture the fixed v0.3.0 MSI marker",
        "\n  ; Capture the fixed v0.3.0 MSI marker",
      ),
      source.replace(
        "Function un.onInit\n  SetRegView 64\n  !insertmacro SetContext\n",
        "Function un.onInit\n  SetRegView 64\n",
      ),
    ]) {
      expect(mutation).not.toBe(source);
      expect(() => verifyTemplate(mutation)).toThrow(
        /must initialize the per-machine shell and registry context|v0\.3\.0 MSI install-path capture/u,
      );
    }
  });

  it("opens only fixed cleanup anchors without following reparse points", () => {
    const source = fs.readFileSync(TEMPLATE, "utf8");
    const noFollowOpen =
      "System::Call 'kernel32::CreateFileW(w \"${Path}\", i ${FYAGENT_DELETE}|${FYAGENT_FILE_READ_ATTRIBUTES}, i ${FYAGENT_FILE_SHARE_READ}, p 0, i ${FYAGENT_OPEN_EXISTING}, i ${FYAGENT_FILE_FLAG_BACKUP_SEMANTICS}|${FYAGENT_FILE_FLAG_OPEN_REPARSE_POINT}, p 0) p .r8'";
    expect(source).toContain(noFollowOpen);
    for (const mutation of [
      source.replace(
        "${FYAGENT_FILE_FLAG_BACKUP_SEMANTICS}|${FYAGENT_FILE_FLAG_OPEN_REPARSE_POINT}",
        "${FYAGENT_FILE_FLAG_BACKUP_SEMANTICS}",
      ),
      source.replace(
        "i ${FYAGENT_FILE_SHARE_READ}, p 0",
        "i ${FYAGENT_FILE_SHARE_READ}|${FYAGENT_FILE_SHARE_WRITE}, p 0",
      ),
      source.replace(
        "GetFileInformationByHandle(p r8, p r6)",
        "GetFileInformationByPath(p r8, p r6)",
      ),
      source.replace(
        "  StrCpy ${OutputHandle} $8",
        "  System::Call 'advapi32::GetSecurityInfo(p r8)'\n  StrCpy ${OutputHandle} $8",
      ),
    ]) {
      expect(mutation).not.toBe(source);
      expect(() => verifyTemplate(mutation)).toThrow(
        /cleanup anchor|fixed cleanup anchor|relative cleanup directory/u,
      );
    }
  });

  it("rejects ACL repair or machine-runtime provisioning", () => {
    const source = fs
      .readFileSync(TEMPLATE, "utf8")
      .replace(
        "!macro FyAgentCleanupLegacyMachineRuntime Label",
        "!macro FyAgentCleanupLegacyMachineRuntime Label\n  nsExec::ExecToStack 'icacls \"$COMMONPROGRAMDATA\\FyAgent\" /grant:r Administrators:F'",
      );
    expect(() => verifyTemplate(source)).toThrow(
      /exact handle-relative|non-provisioning|cleanup anchor/u,
    );

    const reprovisioned = fs
      .readFileSync(TEMPLATE, "utf8")
      .replace(
        "Section EarlyChecks",
        "Function FyAgentProvisionMachineRuntime\nFunctionEnd\n\nSection EarlyChecks",
      );
    expect(() => verifyTemplate(reprovisioned)).toThrow(
      /retired machine-runtime provisioning contract remains executable/u,
    );
  });

  it("keeps legacy cleanup name-exact, handle-relative, and best-effort", () => {
    const source = fs.readFileSync(TEMPLATE, "utf8");
    for (const mutation of [
      source.replace(
        'StrCmp $R4 "business-" 0 fyagent_${Label}_legacy_name_done',
        'StrCmp $R4 "business" 0 fyagent_${Label}_legacy_name_done',
      ),
      source.replace(
        'StrCmp $R4 ".state" 0 fyagent_${Label}_legacy_name_done',
        'StrCmp $R4 ".tmp" 0 fyagent_${Label}_legacy_name_done',
      ),
      source.replace(
        '!insertmacro FyAgentValidateLegacyRuntimeName "$R1" ${Label}_legacy_entry $R5',
        "StrCpy $R5 1",
      ),
      source.replace(
        '!insertmacro FyAgentOpenDirectoryRelativeToHandle r5 $5 "runtime" ${Label}_runtime $3 $2',
        '!insertmacro FyAgentOpenCleanupAnchorDirectory "$COMMONPROGRAMDATA\\FyAgent\\runtime" ${Label}_runtime $3 $2',
      ),
      source.replace(
        '!insertmacro FyAgentDeleteRegularFileRelativeToHandle r3 $3 "$R1" ${Label}_legacy_file',
        'Delete "$COMMONPROGRAMDATA\\FyAgent\\runtime\\$R1"',
      ),
      source.replace(
        'FindFirst $R0 $R1 "$COMMONPROGRAMDATA\\FyAgent\\runtime\\*"',
        'FindFirst $R0 $R1 "$COMMONPROGRAMDATA\\FyAgent\\*"',
      ),
      source.replace(
        "!macro FyAgentCleanupLegacyMachineRuntime Label",
        '!macro FyAgentCleanupLegacyMachineRuntime Label\n  Abort "cleanup failed"',
      ),
      source.replace(
        "!macro FyAgentCleanupLegacyMachineRuntime Label",
        "!macro FyAgentCleanupLegacyMachineRuntime Label\n  Quit",
      ),
      source.replace(
        "FindNext $R0 $R1\n    IfErrors fyagent_${Label}_legacy_close_find",
        "FindNext $R0 $R1\n    IfErrors fyagent_${Label}_close_runtime",
      ),
      source.replace(
        "IfErrors fyagent_${Label}_close_runtime\n\n  fyagent_${Label}_legacy_entry:",
        "IfErrors fyagent_${Label}_legacy_close_find\n\n  fyagent_${Label}_legacy_entry:",
      ),
      source.replace(
        "!insertmacro FyAgentMarkEmptyDirectoryForDeletion r3 ${Label}_legacy_runtime\n    System::Call 'kernel32::CloseHandle(p r3) i .r4'",
        "System::Call 'kernel32::CloseHandle(p r3) i .r4'\n    !insertmacro FyAgentMarkEmptyDirectoryForDeletion r3 ${Label}_legacy_runtime",
      ),
      source.replace(
        "  !insertmacro FyAgentCleanupLegacyMachineRuntime uninstall_legacy_runtime\n",
        "",
      ),
    ]) {
      expect(mutation).not.toBe(source);
      expect(() => verifyTemplate(mutation)).toThrow(
        /legacy|ProgramData|handle-relative|cleanup anchor|early exit/u,
      );
    }
  });

  it("cleans only exact artifacts in canonical direct-child staging UUID directories", () => {
    const source = fs.readFileSync(TEMPLATE, "utf8");
    const mutations = [
      source.replace(
        "StrCmp $R3 36 0 fyagent_${Label}_uuid_done",
        "StrCmp $R3 35 0 fyagent_${Label}_uuid_done",
      ),
      source.replace(
        'StrCmp $R4 "f" fyagent_${Label}_uuid_next',
        'StrCmp $R4 "F" fyagent_${Label}_uuid_next',
      ),
      source.replace(
        '!insertmacro FyAgentValidateCanonicalUuid "$R1" ${Label}_staging_entry $R5',
        "StrCpy $R5 1",
      ),
      source.replace(
        'FindFirst $R0 $R1 "$INSTDIR\\cache\\codex-installer\\*"',
        'FindFirst $R0 $R1 "$INSTDIR\\cache\\*"',
      ),
      source.replace(
        '!insertmacro FyAgentOpenDirectoryRelativeToHandle r5 $5 "codex-installer" ${Label}_staging $3 $2',
        '!insertmacro FyAgentOpenCleanupAnchorDirectory "$INSTDIR\\cache\\codex-installer" ${Label}_staging $3 $2',
      ),
      source.replace(
        '!insertmacro FyAgentOpenDirectoryRelativeToHandle r3 $3 "$R1" ${Label}_staging_child $1 $R6',
        '!insertmacro FyAgentOpenCleanupAnchorDirectory "$INSTDIR\\cache\\codex-installer\\$R1" ${Label}_staging_child $1 $R6',
      ),
      source.replace(
        '!insertmacro FyAgentDeleteRegularFileRelativeToHandle r1 $1 "installer.msix.part" ${Label}_staging_part',
        '!insertmacro FyAgentDeleteRegularFileRelativeToHandle r1 $1 "installer.msix.*" ${Label}_staging_part',
      ),
      source.replace(
        '!insertmacro FyAgentDeleteRegularFileRelativeToHandle r1 $1 "installer.msix" ${Label}_staging_msix',
        'Delete "$INSTDIR\\cache\\codex-installer\\$R1\\installer.msix"',
      ),
      source.replace(
        '!insertmacro FyAgentDeleteRegularFileRelativeToHandle r1 $1 "installer.msix.part" ${Label}_staging_part',
        'Delete "$INSTDIR\\cache\\codex-installer\\$R1\\installer.msix.part"',
      ),
      source.replace(
        "!macro FyAgentCleanupKnownCodexInstallerStaging Label",
        '!macro FyAgentCleanupKnownCodexInstallerStaging Label\n  Abort "cleanup failed"',
      ),
      source.replace(
        "!macro FyAgentCleanupKnownCodexInstallerStaging Label",
        "!macro FyAgentCleanupKnownCodexInstallerStaging Label\n  Quit",
      ),
      source.replace(
        "FindNext $R0 $R1\n    IfErrors fyagent_${Label}_staging_close_find",
        "FindNext $R0 $R1\n    IfErrors fyagent_${Label}_staging_close_root",
      ),
      source.replace(
        "IfErrors fyagent_${Label}_staging_close_root\n\n  fyagent_${Label}_staging_entry:",
        "IfErrors fyagent_${Label}_staging_close_find\n\n  fyagent_${Label}_staging_entry:",
      ),
      source.replace(
        "!insertmacro FyAgentMarkEmptyDirectoryForDeletion r1 ${Label}_staging_child\n        System::Call 'kernel32::CloseHandle(p r1) i .r4'",
        "System::Call 'kernel32::CloseHandle(p r1) i .r4'\n        !insertmacro FyAgentMarkEmptyDirectoryForDeletion r1 ${Label}_staging_child",
      ),
      source.replace(
        "  !insertmacro FyAgentCleanupKnownCodexInstallerStaging uninstall_codex_staging\n",
        "",
      ),
      source.replace(
        "Section Uninstall",
        'Section Uninstall\n  Delete "$INSTDIR\\cache\\*"',
      ),
    ];

    for (const [index, mutation] of mutations.entries()) {
      expect(mutation, `staging cleanup mutation ${index}`).not.toBe(source);
      expect(
        () => verifyTemplate(mutation),
        `staging cleanup mutation ${index}`,
      ).toThrow(
        /staging|canonical|direct-child|handle-relative|branch|early exit|best-effort|installer must not use \$INSTDIR/u,
      );
    }
  });

  it("pins the full parent-handle chain and same-handle dispositions", () => {
    const source = fs.readFileSync(TEMPLATE, "utf8");
    const unicodeString = "System::Call '*(&i2 R2, &i2 R5, p r6, &l.R3) p .r7'";
    const objectAttributes =
      "System::Call '*(&l4, p ${ParentSystemRegister}, p r7, i ${FYAGENT_OBJ_CASE_INSENSITIVE}|${FYAGENT_OBJ_DONT_REPARSE}, p 0, p 0, &l.R3) p .r4'";
    const ioStatusBlock = "System::Call '*(p 0, p 0, &l.R3) p .r0'";
    const directoryOpen =
      "System::Call 'ntdll::NtCreateFile(*p .r8, i ${FYAGENT_DELETE}|${FYAGENT_FILE_READ_ATTRIBUTES}, p r4, p r0, p 0, i 0, i ${FYAGENT_FILE_SHARE_READ}, i ${FYAGENT_FILE_OPEN}, i ${FYAGENT_FILE_DIRECTORY_FILE}|${FYAGENT_FILE_FLAG_OPEN_REPARSE_POINT}, p 0, i 0) i .r2'";
    const leafOpen =
      "System::Call 'ntdll::NtCreateFile(*p .r8, i ${FYAGENT_DELETE}|${FYAGENT_FILE_READ_ATTRIBUTES}, p r4, p r0, p 0, i 0, i ${FYAGENT_FILE_SHARE_READ}, i ${FYAGENT_FILE_OPEN}, i ${FYAGENT_FILE_NON_DIRECTORY_FILE}|${FYAGENT_FILE_FLAG_OPEN_REPARSE_POINT}, p 0, i 0) i .r2'";
    expect(source).toContain(unicodeString);
    expect(source).toContain(objectAttributes);
    expect(source).toContain(ioStatusBlock);
    expect(source).toContain(directoryOpen);
    expect(source).toContain(leafOpen);

    const mutations = [
      source.replace(
        '!insertmacro FyAgentDeleteRegularFileRelativeToHandle r1 $1 "installer.msix" ${Label}_staging_msix',
        'Delete "$INSTDIR\\cache\\codex-installer\\$R1\\installer.msix"',
      ),
      source.replace(
        '!insertmacro FyAgentDeleteRegularFileRelativeToHandle r1 $1 "installer.msix.part" ${Label}_staging_part',
        'Delete "$INSTDIR\\cache\\codex-installer\\$R1\\installer.msix.part"',
      ),
      source.replace(
        objectAttributes,
        objectAttributes.replace(
          "p ${ParentSystemRegister}, p r7",
          "p r3, p r7",
        ),
      ),
      source.replace(
        objectAttributes,
        objectAttributes.replace(
          "p ${ParentSystemRegister}, p r7",
          "p 0, p r7",
        ),
      ),
      source.replace(
        objectAttributes,
        objectAttributes.replace(
          "${FYAGENT_OBJ_CASE_INSENSITIVE}|${FYAGENT_OBJ_DONT_REPARSE}",
          "${FYAGENT_OBJ_CASE_INSENSITIVE}",
        ),
      ),
      source.replace(unicodeString, unicodeString.replace("&i2 R2", "&i2 r2")),
      source.replace(
        "${If} $R7 != ${ParentHandle}",
        "${If} $R7 == ${ParentHandle}",
      ),
      source.replace(
        "!define FYAGENT_NSIS_SYSTEM_POINTER_SIZE 4",
        "!define FYAGENT_NSIS_SYSTEM_POINTER_SIZE 8",
      ),
      source.replace(
        "!define FYAGENT_UNICODE_STRING_SIZE 8",
        "!define FYAGENT_UNICODE_STRING_SIZE 16",
      ),
      source.replace(
        "!define FYAGENT_UNICODE_STRING_BUFFER_OFFSET 4",
        "!define FYAGENT_UNICODE_STRING_BUFFER_OFFSET 8",
      ),
      source.replace(
        "!define FYAGENT_OBJECT_ATTRIBUTES_SIZE 24",
        "!define FYAGENT_OBJECT_ATTRIBUTES_SIZE 48",
      ),
      source.replace(
        "!define FYAGENT_OBJECT_ATTRIBUTES_ROOT_DIRECTORY_OFFSET 4",
        "!define FYAGENT_OBJECT_ATTRIBUTES_ROOT_DIRECTORY_OFFSET 8",
      ),
      source.replace(
        "!define FYAGENT_IO_STATUS_BLOCK_SIZE 8",
        "!define FYAGENT_IO_STATUS_BLOCK_SIZE 16",
      ),
      source.replace(unicodeString, unicodeString.replace("p r6", "P r6")),
      source.replace(
        ioStatusBlock,
        ioStatusBlock.replace("*(p 0, p 0", "*(P 0, P 0"),
      ),
      source.replace(
        leafOpen,
        leafOpen.replace(
          "${FYAGENT_DELETE}|${FYAGENT_FILE_READ_ATTRIBUTES}",
          "${FYAGENT_FILE_READ_ATTRIBUTES}",
        ),
      ),
      source.replace(
        directoryOpen,
        directoryOpen.replace(
          "${FYAGENT_FILE_DIRECTORY_FILE}|${FYAGENT_FILE_FLAG_OPEN_REPARSE_POINT}",
          "${FYAGENT_FILE_DIRECTORY_FILE}",
        ),
      ),
      source.replace(
        leafOpen,
        leafOpen.replace(
          "${FYAGENT_FILE_NON_DIRECTORY_FILE}|${FYAGENT_FILE_FLAG_OPEN_REPARSE_POINT}",
          "${FYAGENT_FILE_NON_DIRECTORY_FILE}",
        ),
      ),
      source.replace(
        leafOpen,
        "System::Call 'kernel32::CreateFileW(w \"$INSTDIR\\cache\\codex-installer\\$R1\\${LeafName}\", i ${FYAGENT_DELETE}|${FYAGENT_FILE_READ_ATTRIBUTES}, i ${FYAGENT_FILE_SHARE_READ}, p 0, i ${FYAGENT_OPEN_EXISTING}, i ${FYAGENT_FILE_FLAG_BACKUP_SEMANTICS}|${FYAGENT_FILE_FLAG_OPEN_REPARSE_POINT}, p 0) p .r8'",
      ),
      source.replace(
        "IntOp $4 $0 & ${FYAGENT_FILE_ATTRIBUTE_DIRECTORY}\n  ${If} $4 <> 0\n    Goto fyagent_${Label}_leaf_close\n  ${EndIf}",
        "IntOp $4 $0 & ${FYAGENT_FILE_ATTRIBUTE_DIRECTORY}",
      ),
      source.replace(
        "IntOp $4 $0 & ${FYAGENT_FILE_ATTRIBUTE_REPARSE_POINT}\n  ${If} $4 <> 0\n    Goto fyagent_${Label}_leaf_close\n  ${EndIf}",
        "IntOp $4 $0 & ${FYAGENT_FILE_ATTRIBUTE_REPARSE_POINT}",
      ),
      source.replace(
        "SetFileInformationByHandle(p r8, i ${FYAGENT_FILE_DISPOSITION_INFO_CLASS}",
        "SetFileInformationByHandle(p r1, i ${FYAGENT_FILE_DISPOSITION_INFO_CLASS}",
      ),
      source.replace(
        "System::Call 'kernel32::SetFileInformationByHandle(p r8, i ${FYAGENT_FILE_DISPOSITION_INFO_CLASS}, p r6, i ${FYAGENT_FILE_DISPOSITION_INFO_SIZE}) i .r7'",
        "System::Call 'kernel32::DeleteFileW(w \"$INSTDIR\\cache\\codex-installer\\$R1\\${LeafName}\") i .r7'",
      ),
      source.replace(
        "System::Call 'kernel32::SetFileInformationByHandle(p ${HandleSystemRegister}, i ${FYAGENT_FILE_DISPOSITION_INFO_CLASS}, p r6, i ${FYAGENT_FILE_DISPOSITION_INFO_SIZE}) i .r7'",
        "System::Call 'kernel32::SetFileInformationByHandle(p r8, i ${FYAGENT_FILE_DISPOSITION_INFO_CLASS}, p r6, i ${FYAGENT_FILE_DISPOSITION_INFO_SIZE}) i .r7'",
      ),
      source.replace(
        "${If} $4 <> 0\n      System::Free $4\n    ${EndIf}",
        "${If} $4 <> 0\n    ${EndIf}",
      ),
    ];

    for (const [index, mutation] of mutations.entries()) {
      expect(mutation, `cleanup primitive mutation ${index}`).not.toBe(source);
      expect(
        () => verifyTemplate(mutation),
        `cleanup primitive mutation ${index}`,
      ).toThrow(
        /staging (?:leaf deletion|cleanup)|cleanup leaf deletion|relative cleanup|handle-relative|same-handle|path delete|full path|cleanup anchor|installer must not use \$INSTDIR/u,
      );
    }
  });

  it("packages and uninstalls the fixed helper with the other known owned surfaces", () => {
    const source = fs.readFileSync(TEMPLATE, "utf8");
    for (const mutation of [
      source.replace('    File /a "/oname={{this}}" "{{no-escape @key}}"', ""),
      source.replace('    Delete "$INSTDIR\\\\{{this}}"', ""),
      source.replace('  Delete "$INSTDIR\\${MAINBINARYNAME}.exe"', ""),
      source.replace('      Delete "$DESKTOP\\${PRODUCTNAME}.lnk"', ""),
      source.replace(
        '      DeleteRegKey SHCTX "Software\\Classes\\\\{{protocol}}"',
        "",
      ),
    ]) {
      expect(mutation).not.toBe(source);
      expect(() => verifyTemplate(mutation)).toThrow(
        /package and remove the configured helper|known owned payload\/registration cleanup|staging cleanup|legacy cleanup|uninstall process gate/u,
      );
    }
  });

  it("waits at most five seconds only in update mode before retaining the process stop gate", () => {
    const source = fs.readFileSync(TEMPLATE, "utf8");
    const mutations = [
      source.replace("StrCpy $FyAgentUpdateProcessRetries 0", ""),
      source.replace("${AndIf} $FyAgentUpdateProcessRetries < 20", ""),
      source.replace(
        "${AndIf} $FyAgentUpdateProcessRetries < 20",
        "${AndIf} $FyAgentUpdateProcessRetries < 200",
      ),
      source.replace(
        "IntOp $FyAgentUpdateProcessRetries $FyAgentUpdateProcessRetries + 1",
        "",
      ),
      source.replace("Sleep 250", "Sleep 2500"),
      source.replace(
        "${If} $UpdateMode = 1\n      ${AndIf} $FyAgentUpdateProcessRetries < 20",
        "${If} $PassiveMode = 1\n      ${AndIf} $FyAgentUpdateProcessRetries < 20",
      ),
      source.replace("Var FyAgentUpdateProcessRetries\n", ""),
    ];
    expect(() => verifyTemplate(source)).not.toThrow();
    for (const mutation of mutations) {
      expect(mutation).not.toBe(source);
      expect(() => verifyTemplate(mutation)).toThrow(
        /process stop gate|retry counter/u,
      );
    }
  });

  it("fails closed while the main or fixed helper process is running without force termination", () => {
    const source = fs.readFileSync(TEMPLATE, "utf8");
    const gateDefinition = source.match(
      /!macro FyAgentRequireProcessStopped ExecutableName DisplayName Label[\s\S]*?!macroend/u,
    )?.[0];
    expect(gateDefinition).toBeDefined();
    const lateGateDefinition = source
      .replace(`${gateDefinition}\n\n`, "")
      .replace(
        "; 5. Choose install directory page",
        `${gateDefinition}\n\n; 5. Choose install directory page`,
      );
    expect(lateGateDefinition).not.toBe(source);
    expect(() => verifyTemplate(lateGateDefinition)).toThrow(
      /process stop gate macro must be defined before its first invocation/u,
    );
    const installGates = [
      '!insertmacro FyAgentRequireProcessStopped "${MAINBINARYNAME}.exe" "${PRODUCTNAME}" install_main',
      '!insertmacro FyAgentRequireProcessStopped "fyagent-user-helper.exe" "${PRODUCTNAME} user helper" install_helper',
    ].join("\n  ");
    const earlyGates = [
      '!insertmacro FyAgentRequireProcessStopped "${MAINBINARYNAME}.exe" "${PRODUCTNAME}" early_main',
      '!insertmacro FyAgentRequireProcessStopped "fyagent-user-helper.exe" "${PRODUCTNAME} user helper" early_helper',
    ].join("\n  ");
    const uninstallGates = [
      '!insertmacro FyAgentRequireProcessStopped "${MAINBINARYNAME}.exe" "${PRODUCTNAME}" uninstall_main',
      '!insertmacro FyAgentRequireProcessStopped "fyagent-user-helper.exe" "${PRODUCTNAME} user helper" uninstall_helper',
    ].join("\n  ");
    const maintenanceGates = [
      '!insertmacro FyAgentRequireProcessStopped "${MAINBINARYNAME}.exe" "${PRODUCTNAME}" maintenance_main',
      '!insertmacro FyAgentRequireProcessStopped "fyagent-user-helper.exe" "${PRODUCTNAME} user helper" maintenance_helper',
    ].join("\n    ");

    for (const forbidden of [
      "CheckIfAppIsRunning",
      "KillProcess",
      "KillProcessCurrentUser",
      "TerminateProcess",
      "taskkill",
    ]) {
      expect(source).not.toContain(forbidden);
    }

    const mutations = [
      source.replace(
        'nsis_tauri_utils::FindProcess "${ExecutableName}"',
        'nsis_tauri_utils::KillProcess "${ExecutableName}"',
      ),
      source.replace(
        "IfSilent fyagent_${Label}_process_silent fyagent_${Label}_process_interactive",
        "IfSilent fyagent_${Label}_process_interactive fyagent_${Label}_process_interactive",
      ),
      source.replace(
        'Abort "${DisplayName} is running. Close it normally, then run setup again."',
        "Goto fyagent_${Label}_process_retry",
      ),
      source.replace(
        'Abort "${DisplayName} is still running. No installer changes were made."',
        "ClearErrors",
      ),
      source.replace(
        '!insertmacro FyAgentRequireProcessStopped "fyagent-user-helper.exe" "${PRODUCTNAME} user helper" install_helper',
        "",
      ),
      source.replace(
        '!insertmacro FyAgentRequireProcessStopped "fyagent-user-helper.exe" "${PRODUCTNAME} user helper" early_helper',
        "",
      ),
      source.replace(
        '!insertmacro FyAgentRequireProcessStopped "fyagent-user-helper.exe" "${PRODUCTNAME} user helper" uninstall_helper',
        "",
      ),
      source.replace(
        '!insertmacro FyAgentRequireProcessStopped "${MAINBINARYNAME}.exe" "${PRODUCTNAME}" maintenance_main',
        "",
      ),
      source.replace(
        'FyAgentRequireProcessStopped "fyagent-user-helper.exe"',
        'FyAgentRequireProcessStopped "unknown-helper.exe"',
      ),
      source
        .replace(`${installGates}\n\n  SetOutPath`, "SetOutPath")
        .replace(
          "  SetOutPath $INSTDIR\n",
          `  SetOutPath $INSTDIR\n  ${installGates}\n`,
        ),
      source
        .replace(`${earlyGates}\n\n  ; Abort`, "; Abort")
        .replace(
          "  Call FyAgentMigrateLegacyWixInstall\n",
          `  Call FyAgentMigrateLegacyWixInstall\n  ${earlyGates}\n`,
        ),
      source
        .replace(
          `${uninstallGates}\n\n  !ifmacrodef NSIS_HOOK_PREUNINSTALL`,
          "!ifmacrodef NSIS_HOOK_PREUNINSTALL",
        )
        .replace(
          "  !insertmacro FyAgentCleanupLegacyMachineRuntime uninstall_legacy_runtime",
          `  !insertmacro FyAgentCleanupLegacyMachineRuntime uninstall_legacy_runtime\n  ${uninstallGates}`,
        ),
      source.replace(
        `${maintenanceGates}\n    HideWindow`,
        `HideWindow\n    ${maintenanceGates}`,
      ),
      source.replace(
        "Section Install",
        "Section Install\n  System::Call 'kernel32::TerminateProcess(p 0, i 1)' i .r0",
      ),
      source.replace(
        "Section Install",
        "Section Install\n  nsExec::Exec 'taskkill /f /im fyagent.exe'",
      ),
    ];

    for (const [index, mutation] of mutations.entries()) {
      expect(mutation, `process gate mutation ${index}`).not.toBe(source);
      expect(
        () => verifyTemplate(mutation),
        `process gate mutation ${index}`,
      ).toThrow(
        /process stop gate|process gates|force-terminate|maintenance uninstall|before MSI migration|process recheck|before hooks/u,
      );
    }
  });

  it("pins the only MSI migration to the frozen v0.3.0 products and fails closed", () => {
    const source = fs.readFileSync(TEMPLATE, "utf8");
    const fixedCommand =
      "ExecWait '\"$SYSDIR\\msiexec.exe\" /x ${FYAGENT_LEGACY_WIX_PRODUCT_CODE} /qn /norestart' $0";
    expect(source).toContain(fixedCommand);

    const mutations = [
      source.replace(
        "{D50D8CE2-B49A-41DE-839D-6574FB69ADC1}",
        "{00000000-0000-0000-0000-000000000001}",
      ),
      source.replace(
        "{78F69296-A73D-40CA-A2BA-11D117AA2C9B}",
        "{00000000-0000-0000-0000-000000000002}",
      ),
      source.replace(
        '!define FYAGENT_LEGACY_WIX_REGISTRY_KEY "Software\\fyagent\\FyAgent"',
        '!define FYAGENT_LEGACY_WIX_REGISTRY_KEY "Software\\fyagent"',
      ),
      source.replace(
        'ReadRegStr $LegacyWixInstallDir HKLM "${FYAGENT_LEGACY_WIX_REGISTRY_KEY}" "InstallDir"',
        'ReadRegStr $LegacyWixInstallDir HKLM "${FYAGENT_LEGACY_WIX_REGISTRY_KEY}" "UninstallString"',
      ),
      source.replace(
        'MsiQueryProductStateW(w "${FYAGENT_LEGACY_WIX_PRODUCT_CODE}")',
        'MsiQueryProductStateW(w "$R1")',
      ),
      source.replace(
        '"$SYSDIR\\msi.dll"::MsiQueryProductStateW',
        "msi::MsiQueryProductStateW",
      ),
      source.replace(
        "Goto fyagent_legacy_wix_migration_accepted\n  ${EndIf}\n\n  ClearErrors",
        "Goto +1\n  ${EndIf}\n\n  ClearErrors",
      ),
      source.replace(fixedCommand, fixedCommand.replace(" /x ", " /i ")),
      source.replace(fixedCommand, fixedCommand.replace(" /qn /norestart", "")),
      source.replace(
        "${OrIf} $0 == ${FYAGENT_MSI_PRODUCT_UNINSTALLED}\n    Goto fyagent_legacy_wix_migration_accepted",
        "${OrIf} $0 == ${FYAGENT_MSI_PRODUCT_UNINSTALLED}\n  ${OrIf} $0 == ${FYAGENT_MSI_REBOOT_REQUIRED}\n    Goto fyagent_legacy_wix_migration_accepted",
      ),
      source.replace(
        "${If} ${Errors}\n    MessageBox MB_ICONSTOP|MB_OK",
        "${If} ${Errors}\n    Goto fyagent_legacy_wix_migration_accepted\n    MessageBox MB_ICONSTOP|MB_OK",
      ),
      source.replace(
        'Abort "Restart Windows before installing FyAgent."',
        "Goto fyagent_legacy_wix_migration_accepted",
      ),
      source.replace(
        'DeleteRegValue HKLM "${FYAGENT_LEGACY_WIX_REGISTRY_KEY}" "InstallDir"',
        "ClearErrors",
      ),
      source
        .replace(
          "  Call FyAgentMigrateLegacyWixInstall\n\nSectionEnd",
          "SectionEnd",
        )
        .replace(
          "  SetOutPath $INSTDIR\n",
          "  SetOutPath $INSTDIR\n  Call FyAgentMigrateLegacyWixInstall\n",
        ),
      source.replace(
        "Section EarlyChecks",
        "Section EarlyChecks\n  ExecWait 'msiexec /x legacy.msi' $0",
      ),
    ];

    for (const [index, mutation] of mutations.entries()) {
      expect(mutation, `v0.3.0 migration mutation ${index}`).not.toBe(source);
      expect(
        () => verifyTemplate(mutation),
        `v0.3.0 migration mutation ${index}`,
      ).toThrow(/v0\.3\.0 MSI|frozen ProductCode|migration|msiexec/u);
    }
  });

  it("rejects recursive deletion of a caller-selected install directory", () => {
    const source = fs
      .readFileSync(TEMPLATE, "utf8")
      .replace('RMDir "$INSTDIR"', 'RMDir /r "$INSTDIR"');
    expect(() => verifyTemplate(source)).toThrow(
      /must never recursively delete a caller-selected \$INSTDIR/u,
    );
  });

  it("rejects drift between the compressed include and repo-owned WebView2 source", () => {
    const include = fs.readFileSync(WEBVIEW_INCLUDE, "utf8");
    const mutated = include.replace(
      /(!define FYAGENT_WEBVIEW2_COMMAND_00 ")([A-Za-z])/u,
      (_match, prefix: string, character: string) =>
        `${prefix}${character === "A" ? "B" : "A"}`,
    );
    const includePath = temporaryFile("webview2-command.nsh", mutated);
    expect(() =>
      verifyWindowsNsisContract({
        baseConfigPath: BASE_CONFIG,
        windowsConfigPath: WINDOWS_CONFIG,
        templatePath: TEMPLATE,
        webviewIncludePath: includePath,
      }),
    ).toThrow(/deterministic level-9 gzip/u);
  });

  it("keeps WebView2 staging ephemeral and independent of the retired runtime parent", () => {
    const source = fs.readFileSync(WEBVIEW_SOURCE, "utf8");
    expect(source).not.toContain("$programDataParent");
    expect(source).toContain(
      "Join-Path $programDataRoot \"FyAgent-WebView2-$([Guid]::NewGuid().ToString('N'))\"",
    );

    for (const rawMutation of [
      source.replace(
        "Join-Path $programDataRoot \"FyAgent-WebView2-$([Guid]::NewGuid().ToString('N'))\"",
        "Join-Path $programDataRoot 'FyAgent'",
      ),
      source.replace(
        "if ([string]::IsNullOrWhiteSpace($programDataRoot) -or -not [IO.Path]::IsPathRooted($programDataRoot)) {",
        "if ([string]::IsNullOrWhiteSpace($programDataRoot)) {",
      ),
      source.replace("$stage.Create($directorySecurity)", "$stage.Create()"),
    ]) {
      const mutation = padWebViewSourceToDeclaredChunkCount(rawMutation);
      expect(mutation).not.toBe(source);
      const sourcePath = temporaryFile(
        "install-webview2-bootstrapper.ps1",
        mutation,
      );
      const includePath = temporaryFile(
        "webview2-command.nsh",
        encodedIncludeForSource(mutation),
      );
      expect(() =>
        verifyWindowsNsisContract({
          baseConfigPath: BASE_CONFIG,
          windowsConfigPath: WINDOWS_CONFIG,
          templatePath: TEMPLATE,
          webviewSourcePath: sourcePath,
          webviewIncludePath: includePath,
        }),
      ).toThrow(
        /ephemeral WebView2 staging|retired ProgramData FyAgent runtime parent/u,
      );
    }
  });

  it("canonicalizes the gzip OS header and pins NSIS text inputs to LF", () => {
    const payload = Buffer.from("FyAgent portable gzip fixture", "utf8");
    const hostSpecific = gzipSync(payload, { level: 9 });
    hostSpecific[9] = 10;
    const canonical = canonicalizeGzipHeader(hostSpecific);

    expect(hostSpecific[9]).toBe(10);
    expect(canonical[9]).toBe(255);
    expect(gunzipSync(canonical)).toEqual(payload);
    expect(gzipDeterministically(payload)[9]).toBe(255);

    const attributes = fs.readFileSync(GIT_ATTRIBUTES, "utf8");
    for (const extension of ["ps1", "nsi", "nsh"]) {
      expect(attributes).toMatch(
        new RegExp(`^\\*\\.${extension} text eol=lf$`, "mu"),
      );
    }
  });

  it("locks a PowerShell 5.1-safe loader and rejects unary-comma method arguments", () => {
    const loader = fs.readFileSync(WEBVIEW_LOADER, "utf8");
    expect(loader).toContain(
      "$c=[byte[]][Convert]::FromBase64String($e);$m=[IO.MemoryStream]::new($c)",
    );
    expect(loader).toContain(
      "[IO.Compression.GZipStream]::new($m,[IO.Compression.CompressionMode]0)",
    );
    expect(loader).not.toMatch(/\[IO\.MemoryStream\]::new\(\s*,/u);
    const incompatible = loader.replace(
      "$c=[byte[]][Convert]::FromBase64String($e);$m=[IO.MemoryStream]::new($c)",
      "$m=[IO.MemoryStream]::new(,[Convert]::FromBase64String($e))",
    );
    const loaderPath = temporaryFile(
      "load-encoded-webview2-command.ps1",
      incompatible,
    );
    const includePath = temporaryFile(
      "webview2-command.nsh",
      encodedIncludeForLoader(incompatible),
    );
    expect(() =>
      verifyWindowsNsisContract({
        baseConfigPath: BASE_CONFIG,
        windowsConfigPath: WINDOWS_CONFIG,
        templatePath: TEMPLATE,
        webviewLoaderPath: loaderPath,
        webviewIncludePath: includePath,
      }),
    ).toThrow(/PowerShell 5\.1-safe byte-array MemoryStream constructor/u);

    const ambiguousGzip = loader.replace(
      "[IO.Compression.CompressionMode]0",
      "0",
    );
    expect(() =>
      verifyWindowsNsisContract({
        baseConfigPath: BASE_CONFIG,
        windowsConfigPath: WINDOWS_CONFIG,
        templatePath: TEMPLATE,
        webviewLoaderPath: temporaryFile(
          "load-encoded-webview2-command.ps1",
          ambiguousGzip,
        ),
        webviewIncludePath: temporaryFile(
          "webview2-command.nsh",
          encodedIncludeForLoader(ambiguousGzip),
        ),
      }),
    ).toThrow(/typed PowerShell 5\.1-safe GZip decompression mode/u);
  });

  it("rejects an unqualified elevated PowerShell security command", () => {
    const source = fs
      .readFileSync(WEBVIEW_SOURCE, "utf8")
      .replace(
        "Microsoft.PowerShell.Security\\Get-AuthenticodeSignature",
        "Get-AuthenticodeSignature",
      );
    const sourcePath = temporaryFile(
      "install-webview2-bootstrapper.ps1",
      source,
    );
    const includePath = temporaryFile(
      "webview2-command.nsh",
      encodedIncludeForSource(source),
    );
    expect(() =>
      verifyWindowsNsisContract({
        baseConfigPath: BASE_CONFIG,
        windowsConfigPath: WINDOWS_CONFIG,
        templatePath: TEMPLATE,
        webviewSourcePath: sourcePath,
        webviewIncludePath: includePath,
      }),
    ).toThrow(/unqualified module command/u);
  });

  it("rejects a WebView2 body read that is not bounded by the shared token", () => {
    const source = fs
      .readFileSync(WEBVIEW_SOURCE, "utf8")
      .replace(
        "$responseStream.ReadAsync(\n      $buffer,\n      0,\n      $buffer.Length,\n      $cancellation.Token\n    )",
        "$responseStream.ReadAsync(\n      $buffer,\n      0,\n      $buffer.Length\n    )",
      );
    const sourcePath = temporaryFile(
      "install-webview2-bootstrapper.ps1",
      source,
    );
    const includePath = temporaryFile(
      "webview2-command.nsh",
      encodedIncludeForSource(source),
    );
    expect(() =>
      verifyWindowsNsisContract({
        baseConfigPath: BASE_CONFIG,
        windowsConfigPath: WINDOWS_CONFIG,
        templatePath: TEMPLATE,
        webviewSourcePath: sourcePath,
        webviewIncludePath: includePath,
      }),
    ).toThrow(/cancellation token must bound both/u);
  });

  it.each([
    ["65535.65535.65535", true],
    ["65536.0.0", false],
    ["9007199254740993.0.0", false],
  ])(
    "gates canonical Cargo version %s before NSIS packaging",
    (version, accepted) => {
      const cargoManifestPath = temporaryFile(
        "Cargo.toml",
        `[workspace.package]\nversion = "${version}"\n`,
      );
      const verify = () =>
        verifyWindowsNsisContract({
          baseConfigPath: BASE_CONFIG,
          windowsConfigPath: WINDOWS_CONFIG,
          templatePath: TEMPLATE,
          cargoManifestPath,
        });
      if (accepted) {
        expect(verify().workspaceVersion).toBe(version);
      } else {
        expect(verify).toThrow(/cannot be bundled by NSIS/u);
      }
    },
  );

  it("authorizes destructive cleanup only after clean preconditions and preserves user parents", () => {
    const lifecycle = fs.readFileSync(LIFECYCLE, "utf8");
    expect(lifecycle).toContain("$cleanupAuthorized = $false");
    expect(lifecycle.indexOf("$cleanupAuthorized = $true")).toBeGreaterThan(
      lifecycle.indexOf("A pre-existing ProgramData\\FyAgent"),
    );
    expect(lifecycle).toMatch(
      /finally \{[\s\S]*?if \(\$cleanupAuthorized\) \{[\s\S]*?Invoke-BestEffortNsisUninstall/u,
    );
    expect(lifecycle).toContain("$sentinelParentsCreatedByTest");
    expect(lifecycle).not.toContain(
      "Remove-Item -LiteralPath $userProfileFyagentDirectory",
    );
  });

  it("rejects unbounded lifecycle process waits and missing timeout diagnostics", () => {
    const lifecycle = fs.readFileSync(LIFECYCLE, "utf8");
    expect(() =>
      assertBoundedLifecycleProcessContract(lifecycle),
    ).not.toThrow();

    const mutations = [
      {
        label: "Start-Process process-tree wait",
        source: `${lifecycle}\nStart-Process -FilePath $InstallerPath -Wait\n`,
      },
      {
        label: "unbounded direct process wait",
        source: lifecycle.replace(
          "$process.WaitForExit($TimeoutMilliseconds)",
          "$process.WaitForExit()\n      # $process.WaitForExit($TimeoutMilliseconds)",
        ),
      },
      {
        label: "single-process termination",
        source: lifecycle.replace(
          "$Process.Kill($true)",
          "$Process.Kill()\n    # $Process.Kill($true)",
        ),
      },
      {
        label: "unbounded root wait after tree kill",
        source: lifecycle.replace(
          "$Process.WaitForExit($processRootExitAfterTreeKillTimeoutMilliseconds)",
          "$Process.WaitForExit()\n    # $Process.WaitForExit($processRootExitAfterTreeKillTimeoutMilliseconds)",
        ),
      },
      {
        label: "descendant termination overclaim",
        source: lifecycle.replace(
          "return 'tree-kill-issued-root-exited'",
          "return 'terminated'\n    # return 'tree-kill-issued-root-exited'",
        ),
      },
      {
        label: "unbounded cleanup",
        source: lifecycle.replace(
          "-TimeoutMilliseconds $cleanupNsisTimeoutMilliseconds",
          "-TimeoutMilliseconds $nsisProcessTimeoutMilliseconds\n      # -TimeoutMilliseconds $cleanupNsisTimeoutMilliseconds",
        ),
      },
      {
        label: "cleanup error isolation",
        source: lifecycle.replace(
          "try {\n    $uninstaller = Join-Path $InstallDirectory 'uninstall.exe'",
          "$uninstaller = Join-Path $InstallDirectory 'uninstall.exe'",
        ),
      },
      {
        label: "quoted NSIS ArgumentList transport",
        source: lifecycle.replace(
          "$startInfo.Arguments = [string]::Join(' ', $Arguments)",
          "foreach ($argument in $Arguments) {\n    [void]$startInfo.ArgumentList.Add($argument)\n  }\n  # $startInfo.Arguments = [string]::Join(' ', $Arguments)",
        ),
      },
      {
        label: "non-Ordinal NSIS /D argument shape",
        source: lifecycle.replace(
          "$Arguments[1].StartsWith('/D=', [StringComparison]::Ordinal)",
          "$Arguments[1].StartsWith('/D=')\n        # $Arguments[1].StartsWith('/D=', [StringComparison]::Ordinal)",
        ),
      },
      {
        label: "empty NSIS /D argument shape",
        source: lifecycle.replace(
          "$Arguments[1].Length -gt 3 -and\n        $Arguments[1].StartsWith('/D=', [StringComparison]::Ordinal)",
          "$true -and\n        $Arguments[1].StartsWith('/D=', [StringComparison]::Ordinal)\n        # nonempty /D= check removed",
        ),
      },
      {
        label: "non-Ordinal NSIS uninstall argument shape",
        source: lifecycle.replace(
          "$Arguments[1].StartsWith('_?=', [StringComparison]::Ordinal)",
          "$Arguments[1].StartsWith('_?=')\n    # $Arguments[1].StartsWith('_?=', [StringComparison]::Ordinal)",
        ),
      },
      {
        label: "empty NSIS uninstall argument shape",
        source: lifecycle.replace(
          "$Arguments[1].Length -gt 3 -and\n    $Arguments[1].StartsWith('_?=', [StringComparison]::Ordinal)",
          "$true -and\n    $Arguments[1].StartsWith('_?=', [StringComparison]::Ordinal)\n    # nonempty _?= check removed",
        ),
      },
      {
        label: "NSIS control-character argument shape",
        source: lifecycle.replace(
          "if ([char]::IsControl($character)) {",
          "if ($false) { # if ([char]::IsControl($character)) {",
        ),
      },
      {
        label: "stdout async drain",
        source: lifecycle.replace(
          "$standardOutputTask = $process.StandardOutput.ReadToEndAsync()",
          "$standardOutputTask = $process.StandardOutput.ReadToEnd()\n      # $standardOutputTask = $process.StandardOutput.ReadToEndAsync()",
        ),
      },
      {
        label: "stderr async drain",
        source: lifecycle.replace(
          "$standardErrorTask = $process.StandardError.ReadToEndAsync()",
          "$standardErrorTask = $process.StandardError.ReadToEnd()\n      # $standardErrorTask = $process.StandardError.ReadToEndAsync()",
        ),
      },
      {
        label: "stdout drain starts after process wait",
        source: lifecycle.replace(
          "$standardOutputTask = $process.StandardOutput.ReadToEndAsync()",
          "$null = $process.WaitForExit($TimeoutMilliseconds)\n      $standardOutputTask = $process.StandardOutput.ReadToEndAsync()",
        ),
      },
      {
        label: "stderr drain starts after process wait",
        source: lifecycle.replace(
          "$standardErrorTask = $process.StandardError.ReadToEndAsync()",
          "$null = $process.WaitForExit($TimeoutMilliseconds)\n      $standardErrorTask = $process.StandardError.ReadToEndAsync()",
        ),
      },
      {
        label: "unbounded redirected output result",
        source: lifecycle.replace(
          "if (-not [Threading.Tasks.Task]::WaitAll(",
          "$null = $StandardOutputTask.GetAwaiter().GetResult()\n    if (-not [Threading.Tasks.Task]::WaitAll(",
        ),
      },
      {
        label: "completed stdout salvage after drain failure",
        source: lifecycle.replace(
          "$StandardOutputTask.Status -eq [Threading.Tasks.TaskStatus]::RanToCompletion",
          "$false\n      # $StandardOutputTask.Status -eq [Threading.Tasks.TaskStatus]::RanToCompletion",
        ),
      },
      {
        label: "completed stderr salvage after drain failure",
        source: lifecycle.replace(
          "$StandardErrorTask.Status -eq [Threading.Tasks.TaskStatus]::RanToCompletion",
          "$false\n      # $StandardErrorTask.Status -eq [Threading.Tasks.TaskStatus]::RanToCompletion",
        ),
      },
      {
        label: "captured stdout retained on timeout",
        source: lifecycle.replace(
          "$standardOutput = $drain.StandardOutput",
          "$standardOutput = ''\n        # $standardOutput = $drain.StandardOutput",
        ),
      },
      {
        label: "captured stderr retained on timeout",
        source: lifecycle.replace(
          "$standardError = $drain.StandardError",
          "$standardError = ''\n        # $standardError = $drain.StandardError",
        ),
      },
      {
        label: "signature verifier exit outcome",
        source: lifecycle.replace(
          "    -CaptureOutput `\n    -ExpectedExit $expectedExit",
          "    -CaptureOutput\n    # -ExpectedExit $expectedExit",
        ),
      },
      {
        label: "native tool exit outcome",
        source: lifecycle.replace(
          "    -CaptureOutput `\n    -ExpectedExit Zero",
          "    -CaptureOutput\n    # -ExpectedExit Zero",
        ),
      },
      {
        label: "captured stdout failure detail",
        source: lifecycle.replace(
          '"stdout=$($StandardOutput.TrimEnd())"',
          "'discarded-stdout'\n      # \"stdout=$($StandardOutput.TrimEnd())\"",
        ),
      },
      {
        label: "captured stderr failure detail",
        source: lifecycle.replace(
          '"stderr=$($StandardError.TrimEnd())"',
          "'discarded-stderr'\n      # \"stderr=$($StandardError.TrimEnd())\"",
        ),
      },
      {
        label: "captured output diagnostic non-masking fallback",
        source: lifecycle.replace(
          "return '; captured-output-formatting-failed'",
          "throw\n    # return '; captured-output-formatting-failed'",
        ),
      },
      {
        label: "timeout captured output propagation",
        source: lifecycle.replace(
          "$capturedOutputDetail = Get-CapturedProcessOutputFailureDetail `",
          "$capturedOutputDetail = ''\n      # Get-CapturedProcessOutputFailureDetail `",
        ),
      },
      {
        label: "case-local uninstaller copy",
        source: lifecycle.replace(
          "[IO.File]::Copy($sourceUninstaller, $copiedUninstaller, $false)",
          "$null = $sourceUninstaller\n    # [IO.File]::Copy($sourceUninstaller, $copiedUninstaller, $false)",
        ),
      },
      {
        label: "case-local uninstaller execution",
        source: lifecycle.replace(
          "-FilePath $copiedUninstaller",
          "-FilePath $sourceUninstaller\n      # -FilePath $copiedUninstaller",
        ),
      },
      {
        label: "bare silent uninstall",
        source: lifecycle.replace(
          "-Arguments @('/S', \"_?=$InstallDirectory\")",
          "-Arguments @('/S')\n      # -Arguments @('/S', \"_?=$InstallDirectory\")",
        ),
      },
      {
        label: "reordered NSIS uninstall arguments",
        source: lifecycle.replace(
          "-Arguments @('/S', \"_?=$InstallDirectory\")",
          "-Arguments @(\"_?=$InstallDirectory\", '/S')\n      # -Arguments @('/S', \"_?=$InstallDirectory\")",
        ),
      },
      {
        label: "recursive case-local uninstaller cleanup",
        source: lifecycle.replace(
          "Remove-Item -LiteralPath $copyRoot -Force -ErrorAction Stop",
          "Remove-Item -LiteralPath $copyRoot -Recurse -Force -ErrorAction Stop\n        # Remove-Item -LiteralPath $copyRoot -Force -ErrorAction Stop",
        ),
      },
      {
        label: "cleanup uninstall bypasses shared helper",
        source: lifecycle.replace(
          "Invoke-NsisUninstall `\n      -InstallDirectory $InstallDirectory `",
          "Invoke-NsisProcess `\n      -FilePath $uninstaller `\n      -Arguments @('/S') `\n      # Invoke-NsisUninstall `\n      # -InstallDirectory $InstallDirectory `",
        ),
      },
      {
        label: "ordinary uninstall bypasses shared helper",
        source: lifecycle.replace(
          "Invoke-NsisUninstall `\n    -InstallDirectory $defaultInstallDir `",
          "Invoke-NsisProcess `\n    -FilePath (Join-Path $defaultInstallDir 'uninstall.exe') `\n    -Arguments @('/S') `\n    # Invoke-NsisUninstall `\n    # -InstallDirectory $defaultInstallDir `",
        ),
      },
      {
        label: "dead helper with live bare silent uninstall",
        source: lifecycle.replace(
          "Invoke-NsisUninstall `\n    -InstallDirectory $defaultInstallDir `\n    -CaseName 'default-uninstall-user-data-preservation' `\n    -WorkingDirectory $testRoot",
          "if ($false) {\n    Invoke-NsisUninstall `\n      -InstallDirectory $defaultInstallDir `\n      -CaseName 'default-uninstall-user-data-preservation' `\n      -WorkingDirectory $testRoot\n  }\n  [void](Invoke-NsisProcess `\n    -FilePath (Join-Path $defaultInstallDir 'uninstall.exe') `\n    -Arguments @('/S') `\n    -ShouldSucceed $true `\n    -CaseName 'default-uninstall-user-data-preservation' `\n    -WorkingDirectory $testRoot)",
        ),
      },
      {
        label: "dead ordinary case with aliased live bare silent uninstall",
        source: lifecycle.replace(
          `  # CASE: default-uninstall-user-data-preservation
  Invoke-NsisUninstall \`
    -InstallDirectory $defaultInstallDir \`
    -CaseName 'default-uninstall-user-data-preservation' \`
    -WorkingDirectory $testRoot
  Assert-UninstalledState -InstallDirectory $defaultInstallDir -UserSentinels $userSentinels`,
          `  if ($false) {
  # CASE: default-uninstall-user-data-preservation
  Invoke-NsisUninstall \`
    -InstallDirectory $defaultInstallDir \`
    -CaseName 'default-uninstall-user-data-preservation' \`
    -WorkingDirectory $testRoot
  Assert-UninstalledState -InstallDirectory $defaultInstallDir -UserSentinels $userSentinels
  }
  $installedUninstallerPath = Join-Path $defaultInstallDir 'uninstall.exe'
  [void](Invoke-NsisProcess \`
    -FilePath $installedUninstallerPath \`
    -Arguments @('/S') \`
    -ShouldSucceed $true \`
    -CaseName 'default-uninstall-user-data-preservation' \`
    -WorkingDirectory $testRoot)`,
        ),
      },
      {
        label: "case end diagnostics",
        source: lifecycle.replace(
          "'CASE END name={0} utc={1} pid={2} elapsedMs={3} exitCode={4} outcome={5}' -f",
          "'CASE FINISH name={0} utc={1} pid={2} elapsedMs={3} exitCode={4} outcome={5}' -f\n      # 'CASE END name={0} utc={1} pid={2} elapsedMs={3} exitCode={4} outcome={5}' -f",
        ),
      },
      {
        label: "process disposal",
        source: lifecycle.replace(
          "$process.Dispose()",
          "$null = $process\n      # $process.Dispose()",
        ),
      },
    ];

    for (const mutation of mutations) {
      expect(mutation.source, mutation.label).not.toBe(lifecycle);
      expect(
        () => assertBoundedLifecycleProcessContract(mutation.source),
        mutation.label,
      ).toThrow();
    }
  });

  it.each([
    "# CASE: webview2-signed-space-unicode-verify",
    "# CASE: webview2-current-user-fake-root-negative",
  ])("rejects deletion of the native lifecycle case %s", (caseLabel) => {
    const lifecycle = fs.readFileSync(LIFECYCLE, "utf8").replace(caseLabel, "");
    const lifecyclePath = temporaryFile(
      "verify-windows-nsis-lifecycle.ps1",
      lifecycle,
    );
    expect(() =>
      verifyWindowsNsisContract({
        baseConfigPath: BASE_CONFIG,
        windowsConfigPath: WINDOWS_CONFIG,
        templatePath: TEMPLATE,
        lifecyclePath,
      }),
    ).toThrow(/native lifecycle is missing CASE:/u);
  });

  it("rejects a Windows config that reintroduces install-scope choice", () => {
    const config = JSON.parse(fs.readFileSync(WINDOWS_CONFIG, "utf8")) as {
      bundle: { windows: { nsis: { installMode: string } } };
    };
    config.bundle.windows.nsis.installMode = "both";
    const configPath = temporaryFile(
      "tauri.windows.conf.json",
      `${JSON.stringify(config, null, 2)}\n`,
    );
    expect(() =>
      verifyWindowsNsisContract({
        baseConfigPath: BASE_CONFIG,
        windowsConfigPath: configPath,
        templatePath: TEMPLATE,
      }),
    ).toThrow(/installMode must be perMachine/u);
  });

  it("rejects a Windows config that omits or renames the fixed helper binary", () => {
    const original = JSON.parse(fs.readFileSync(WINDOWS_CONFIG, "utf8")) as {
      bundle: { externalBin: string[] };
    };
    for (const externalBin of [
      [],
      ["binaries/renamed-helper"],
      ["binaries/fyagent-user-helper", "binaries/unknown-helper"],
    ]) {
      const config = structuredClone(original);
      config.bundle.externalBin = externalBin;
      const configPath = temporaryFile(
        "tauri.windows.conf.json",
        `${JSON.stringify(config, null, 2)}\n`,
      );
      expect(() =>
        verifyWindowsNsisContract({
          baseConfigPath: BASE_CONFIG,
          windowsConfigPath: configPath,
          templatePath: TEMPLATE,
        }),
      ).toThrow(/fixed current-user helper binary/u);
    }
  });
});
