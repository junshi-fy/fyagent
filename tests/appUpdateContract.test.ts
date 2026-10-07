import fs from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  fs.readFileSync(path.join(process.cwd(), file), "utf8");

describe("FyAgent application update contract", () => {
  it("leaves update artifacts and .sig generation to the release pipeline when its signing private key is available, avoiding default build failures without a private key", () => {
    const config = JSON.parse(read("src-tauri/tauri.conf.json"));
    // 更新产物和 .sig 由发版流水线在签名私钥可用时生成；默认构建不打开此开关，避免没有私钥时打包失败。
    expect(config.bundle.createUpdaterArtifacts).toBe(false);
    expect(config.plugins.updater).toEqual({
      pubkey:
        "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEIyNEQ0NDZGNUI4MEY5NTEKUldSUitZQmJiMFJOc3VtYllRV3Y1RHNiak95S1dYczBqeTF4YnR6MlNOUTB4cEJJSUJWRm9YS3cK",
      endpoints: [
        "https://github.com/fy-agent/fyagent/releases/latest/download/latest.json",
      ],
      windows: { installMode: "passive" },
    });
    expect(read("src-tauri/Cargo.toml")).toMatch(
      /^tauri-plugin-updater = "2"$/mu,
    );
  });

  it("exposes only the two application-owned update commands", () => {
    const permission = parseToml(
      read("src-tauri/permissions/app-update.toml"),
    ) as {
      permission: { identifier: string; commands: { allow: string[] } }[];
    };
    expect(permission.permission).toHaveLength(1);
    expect(permission.permission[0].commands.allow).toEqual([
      "check_app_update",
      "install_app_update",
    ]);
    const capability = JSON.parse(read("src-tauri/capabilities/default.json"));
    expect(capability.permissions).toContain(
      permission.permission[0].identifier,
    );
    expect(
      capability.permissions.filter((value: string) =>
        value.startsWith("updater:"),
      ),
    ).toEqual([]);
    expect(JSON.parse(read("package.json")).dependencies).not.toHaveProperty(
      "@tauri-apps/plugin-updater",
    );
  });
});
