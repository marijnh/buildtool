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

@build

@watch

@BuildOptions

## Community

This is open source software released under an
[MIT license](https://github.com/marijnh/buildtool/blob/master/LICENSE).

Development happens on
[GitHub](https://github.com/marijnh/buildtool/). Use the [bug
tracker](https://github.com/marijnh/buildtool/issues) to report
problems.
