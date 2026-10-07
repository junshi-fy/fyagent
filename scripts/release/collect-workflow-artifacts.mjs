#!/usr/bin/env node

import { constants, copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  EXPECTED_INSTALLERS_BY_TARGET,
  EXPECTED_TARGETS,
  WINDOWS_SIGNING_FRAGMENTS_BY_TARGET,
  assertExactDirectorySet,
  assertExactFileSet,
  expectedInstallerNames,
  updaterArtifactNames,
} from "./release-contract.mjs";

const [mode, inputRoot, outputDirectory, version] = process.argv.slice(2);
if (!mode || !inputRoot || !outputDirectory || !version) {
  console.error(
    "Usage: node scripts/release/collect-workflow-artifacts.mjs <installers|metadata|signing|updates> <download-root> <output-dir> <version>",
  );
  process.exit(1);
}

try {
  if (mode === "updates") {
    const names = updaterArtifactNames(version);
    assertExactFileSet(inputRoot, names, "formal updater artifact");
    mkdirSync(outputDirectory);
    for (const name of names) {
      copyFileSync(
        join(inputRoot, name),
        join(outputDirectory, name),
        constants.COPYFILE_EXCL,
      );
    }
    assertExactFileSet(outputDirectory, names, "collected updater artifact");
    console.log(
      "Collected exactly five formal updater files without overwrite",
    );
    process.exit(0);
  }
  if (!(mode === "installers" || mode === "metadata" || mode === "signing")) {
    throw new Error(`Unsupported artifact collection mode: ${mode}`);
  }
  const installerNames = expectedInstallerNames(version);
  const targetGroups =
    mode === "signing"
      ? Object.keys(WINDOWS_SIGNING_FRAGMENTS_BY_TARGET)
      : EXPECTED_TARGETS.map(({ targetGroup }) => targetGroup);
  const artifactNames = targetGroups.map(
    (targetGroup) => `${mode}-${targetGroup}`,
  );
  assertExactDirectorySet(
    inputRoot,
    artifactNames,
    `${mode} artifact download root`,
  );
  mkdirSync(outputDirectory);

  for (const targetGroup of targetGroups) {
    const artifactDirectory = join(inputRoot, `${mode}-${targetGroup}`);
    const expected =
      mode === "installers"
        ? EXPECTED_INSTALLERS_BY_TARGET[targetGroup].map(
            (index) => installerNames[index],
          )
        : mode === "metadata"
          ? [`${targetGroup}.json`]
          : [WINDOWS_SIGNING_FRAGMENTS_BY_TARGET[targetGroup]];
    assertExactFileSet(
      artifactDirectory,
      expected,
      `${mode}-${targetGroup} artifact`,
    );
    for (const name of expected) {
      copyFileSync(
        join(artifactDirectory, name),
        join(outputDirectory, name),
        constants.COPYFILE_EXCL,
      );
    }
  }

  const expectedOutput =
    mode === "installers"
      ? installerNames
      : mode === "metadata"
        ? targetGroups.map((targetGroup) => `${targetGroup}.json`)
        : targetGroups.map(
            (targetGroup) => WINDOWS_SIGNING_FRAGMENTS_BY_TARGET[targetGroup],
          );
  assertExactFileSet(
    outputDirectory,
    expectedOutput,
    `${mode} collected output`,
  );
  console.log(
    `Collected exactly ${expectedOutput.length} ${mode} files without overwrite`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
