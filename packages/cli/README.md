# @divlet/cli

The command-line adapter for divlet. This package owns its implementation and depends on the exact matching `@divlet/core` product version; the core does not contain another copy.

Install:

```bash
npx -y @divlet/cli@0.0.1 ./my-project
```

The installed binary is `divlet`. Importing the package exposes `runCli` without starting a service; the executable starts it explicitly. Checkout commands use `node scripts/source.mjs packages/cli/index.js` from the repository root.

Shared development, release notes and publication guidance live in the [divlet repository](https://github.com/llblab/divlet).
