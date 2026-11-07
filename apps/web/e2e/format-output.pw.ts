import { readFile } from "node:fs/promises";
import { test } from "@playwright/test";
import prettier from "prettier";

test("temporary formatter output", async () => {
  const targets = ["session.pw.ts", "settings-unmount.pw.ts"];
  for (const target of targets) {
    const source = await readFile(new URL(`./${target}`, import.meta.url), "utf8");
    const formatted = await prettier.format(source, {
      filepath: `apps/web/e2e/${target}`,
    });
    console.log(`PRETTIER_OUTPUT_START:${target}`);
    console.log(formatted);
    console.log(`PRETTIER_OUTPUT_END:${target}`);
  }
});
