# @marijn/buildtool

Utility to build TypeScript projects that conform to a given set of
conventions quickly and cleanly. Exports functions that wrap the
TypeScript compiler and Rollup to build or watch one or more projects
in one go, performing a single shared build (so that files from
different projects aren't compiled twice).

Assumes your projects are set up like this:

 - TypeScript files in an `src` directory, will be compiled to
   `dist/index.js` (ES module), `dist/index.cjs` (CommonJS), and
   `dist/index.d.ts` (TypeScript) files.

 - Tests, if any, under `test`, will be compiled in-place to `.js`
   files, which are ES modules.

 - Doc comments prefixed with triple slash `///` syntax will be
   converted to `/**` JSDoc comments in the output, so that TypeScript
   tooling picks them up.

## API

 * **`build`**`(main: string | readonly string[], options?: BuildOptions = {}) → Promise`\
   Build the package with main entry point `main`, or the set of
   packages with the given entry point files. Output files will be
   written to the `dist` directory one level up from the entry file.
   Any TypeScript files in a `test` directory one level up from main
   files will be built in-place.


 * **`watch`**`(mains: readonly string[], extra?: readonly string[] = [], options?: BuildOptions = {})`\
   Build the given packages, along with an optional set of extra
   files, and keep rebuilding them every time an input file changes.


### interface BuildOptions

Options passed to `build` or `watch`.

 * **`sourceMap`**`?: boolean`\
   Generate sourcemap when generating bundle. defaults to false

 * **`tsOptions`**`?: any`\
   Additional compiler options to pass to TypeScript.

 * **`bundleName`**`?: string`\
   Base filename to use for the output bundle and declaration
   files. Defaults to `"index"`.

 * **`expandLink`**`?: fn(anchor: string) → string | null`\
   When given, this is used to convert anchor links in the `///`
   comments to full URLs.

 * **`outputPlugin`**`?: fn(root: string) → Plugin | Promise`\
   Adds a Rollup output plugin to use.

 * **`cjsOutputPlugin`**`?: fn(root: string) → Plugin`\
   Adds an output plugin to use only for CommonJS bundles.

 * **`pureTopCalls`**`?: boolean`\
   When set to true, add a `/*@__PURE__*/` comment before top level
   function calls, so that tree shakers will consider them pure.
   Note that this can break your code if it makes top-level
   function calls that have side effects.

 * **`onRebuildStart`**`?: fn(packages: readonly string[])`\
   Function to call when starting a rebuild via `watch`, passing
   the root directories of the packages that are being built. The
   default is to just log the base names of the directories.

 * **`onRebuildEnd`**`?: fn(packages: readonly string[])`\
   Function to call when finishing a rebuild.


## Community

This is open source software released under an
[MIT license](https://github.com/marijnh/buildtool/blob/master/LICENSE).

Development happens on
[GitHub](https://github.com/marijnh/buildtool/). Use the [bug
tracker](https://github.com/marijnh/buildtool/issues) to report
problems.

