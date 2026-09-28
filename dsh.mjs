#!/usr/bin/env node
// dsh 启动包装：绕开 tsx 下 import.meta.main 失效问题
import { runCli } from "./apps/cli/src/bin.ts"
await runCli()
