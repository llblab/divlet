# @divlet/pi

The Pi adapter for divlet: the `/divlet` command, seven shared layout tools and the product's workflow skill. This package owns its implementation; it is not a wrapper around a second adapter in `@divlet/core`.

Install:

```bash
pi install npm:@divlet/pi@0.0.1
```

It depends on the exact matching `@divlet/core` product version. Pi supplies `typebox` as a peer. For checkout development, run `NODE_OPTIONS=--conditions=divlet-source pi -e /absolute/path/to/divlet/packages/pi/index.js`; do not load a second copy at the same time. A built local package can be installed by its directory after `npm run build`.

Shared development, release notes and publication guidance live in the [divlet repository](https://github.com/llblab/divlet).
