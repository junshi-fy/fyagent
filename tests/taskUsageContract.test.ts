import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");

type TaskDefinition = {
  confirm?: { default?: string; message?: string };
  env: { FYAGENT_TASK_EFFECT: string };
  interactive?: boolean;
  raw?: boolean;
  usage?: string;
};

type ContractModule = {
  PARAMETERIZED_TASKS: readonly string[];
  REQUIRED_PARAMETERIZED_TASKS: readonly string[];
  usageDeclaresParameters(usage: unknown): boolean;
  parameterizedTasksFrom(tasks: Record<string, TaskDefinition>): string[];
  assertTaskUsageContracts(tasks: Record<string, TaskDefinition>): void;
  loadTaskDefinitions(): Record<string, TaskDefinition>;
};

describe("task usage contracts", () => {
  it("derives parameterized tasks from arg/flag declarations and rejects help-only usage", async () => {
    const contract = (await import(
      /* @vite-ignore */ pathToFileURL(
        path.join(ROOT, "scripts", "tasks", "task-contract-check.mjs"),
      ).href
    )) as ContractModule;
    const tasks = contract.loadTaskDefinitions();
    expect(contract.PARAMETERIZED_TASKS).toEqual(
      contract.parameterizedTasksFrom(tasks),
    );
    expect(contract.PARAMETERIZED_TASKS).toContain("rust:test");
    expect(contract.PARAMETERIZED_TASKS).toContain("env:check");
    expect(contract.PARAMETERIZED_TASKS).not.toContain("rust:check");
    expect(contract.PARAMETERIZED_TASKS).not.toContain("build");
    expect(Object.isFrozen(contract.PARAMETERIZED_TASKS)).toBe(true);
    expect(Object.isFrozen(contract.REQUIRED_PARAMETERIZED_TASKS)).toBe(true);
    expect(contract.REQUIRED_PARAMETERIZED_TASKS).toHaveLength(38);

    for (const usage of [
      'help "说明"',
      "# 无参数",
      '# arg "[filters]"',
      'help "arg \"[filters]\""',
    ]) {
      expect(contract.usageDeclaresParameters(usage), usage).toBe(false);
      const fixture = {
        ...tasks,
        "contract:help:fixture": { ...tasks["rust:test"], usage },
      };
      expect(contract.parameterizedTasksFrom(fixture)).not.toContain(
        "contract:help:fixture",
      );
      expect(() => contract.assertTaskUsageContracts(fixture)).toThrow(
        "Task contract:help:fixture usage must declare an arg or flag",
      );
    }
  });

  it("rejects missing tasks and missing or help-only usage in the required baseline", async () => {
    const contract = (await import(
      /* @vite-ignore */ pathToFileURL(
        path.join(ROOT, "scripts", "tasks", "task-contract-check.mjs"),
      ).href
    )) as ContractModule;
    const missingTask = contract.loadTaskDefinitions();
    delete missingTask["rust:test"];
    expect(() => contract.assertTaskUsageContracts(missingTask)).toThrow(
      "Parameterized task rust:test must declare non-empty usage",
    );
    const missingUsage = contract.loadTaskDefinitions();
    delete missingUsage["rust:test"].usage;
    expect(contract.parameterizedTasksFrom(missingUsage)).not.toContain(
      "rust:test",
    );
    expect(() => contract.assertTaskUsageContracts(missingUsage)).toThrow(
      "Parameterized task rust:test must declare non-empty usage",
    );
    missingUsage["rust:test"].usage = 'help "说明"';
    expect(() => contract.assertTaskUsageContracts(missingUsage)).toThrow(
      "Parameterized task rust:test must declare non-empty usage",
    );
  });

  it("accepts new arg/flag tasks without extending the required baseline", async () => {
    const contract = (await import(
      /* @vite-ignore */ pathToFileURL(
        path.join(ROOT, "scripts", "tasks", "task-contract-check.mjs"),
      ).href
    )) as ContractModule;
    const tasks = contract.loadTaskDefinitions();
    const baseline = [...contract.REQUIRED_PARAMETERIZED_TASKS];
    for (const usage of [
      'arg "[filters]"',
      'flag "--json"',
      '\nhelp "说明"\n  arg "[filters]"\n  flag "--json"\n',
    ]) {
      const fixture = {
        ...tasks,
        "contract:usage:fixture": { ...tasks["rust:test"], usage },
      };
      expect(contract.usageDeclaresParameters(usage)).toBe(true);
      expect(contract.parameterizedTasksFrom(fixture)).toContain(
        "contract:usage:fixture",
      );
      expect(contract.REQUIRED_PARAMETERIZED_TASKS).not.toContain(
        "contract:usage:fixture",
      );
      expect(() => contract.assertTaskUsageContracts(fixture)).not.toThrow();
    }
    expect(contract.REQUIRED_PARAMETERIZED_TASKS).toEqual(baseline);
  });
});
