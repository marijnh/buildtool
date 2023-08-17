import * as ts from "typescript"
import {join, dirname, basename, resolve} from "path"
import * as fs from "fs"
import {rollup, RollupBuild, Plugin, SourceMap} from "rollup"
import dts from "rollup-plugin-dts"
import {parse, Node} from "acorn"
import {recursive} from "acorn-walk"

const pkgCache: {[main: string]: Package} = Object.create(null)

function tsFiles(dir: string) {
  return fs.readdirSync(dir).filter(f => /(?<!\.d)\.ts$/.test(f)).map(f => join(dir, f))
}

/// Options passed to `build` or `watch`.
export interface BuildOptions {
  /// Generate sourcemap when generating bundle. defaults to false
  sourceMap?: boolean
  /// Additional compiler options to pass to TypeScript.
  tsOptions?: any
  /// Base filename to use for the output bundle and declaration
  /// files. Defaults to `"index"`.
  bundleName?: string
  /// When given, this is used to convert anchor links in the `///`
  /// comments to full URLs.
  expandLink?: (anchor: string) => string | null
  /// Adds a Rollup output plugin to use.
  outputPlugin?: (root: string) => Plugin | Promise<Plugin>
  /// Adds an output plugin to use only for CommonJS bundles.
  cjsOutputPlugin?: (root: string) => Plugin
  /// When set to true, add a `/*@__PURE__*/` comment before top level
  /// function calls, so that tree shakers will consider them pure.
  /// Note that this can break your code if it makes top-level
  /// function calls that have side effects.
  pureTopCalls?: boolean
  /// Function to call when starting a rebuild via `watch`, passing
  /// the root directories of the packages that are being built. The
  /// default is to just log the base names of the directories.
  onRebuildStart?: (packages: readonly string[]) => void
  /// Function to call when finishing a rebuild.
  onRebuildEnd?: (packages: readonly string[]) => void
}

class Package {
  readonly root: string
  readonly dirs: readonly string[]
  readonly tests: readonly string[]
  readonly json: any

  constructor(readonly main: string) {
    let src = dirname(main), root = dirname(src), tests = join(root, "test")
    this.root = root
    let dirs = this.dirs = [src]
    if (fs.existsSync(tests)) {
      this.tests = tsFiles(tests)
      dirs.push(tests)
    } else {
      this.tests = []
    }
    this.json = JSON.parse(fs.readFileSync(join(this.root, "package.json"), "utf8"))
  }

  static get(main: string): Package {
    return pkgCache[main] || (pkgCache[main] = new Package(main))
  }
}

const tsDefaultOptions = {
  lib: ["es6", "scripthost", "dom"],
  types: ["mocha"],
  stripInternal: true,
  noUnusedLocals: true,
  strict: true,
  target: "es6",
  module: "es2020",
  newLine: "lf",
  declaration: true,
  moduleResolution: "node"
}

function configFor(pkgs: readonly Package[], extra: readonly string[] = [], options: BuildOptions) {
  let paths: ts.MapLike<string[]> = {}
  for (let pkg of pkgs) paths[pkg.json.name] = [pkg.main]
  let {sourceMap, tsOptions} = options
  return {
    compilerOptions: {paths, ...tsDefaultOptions, ...tsOptions, sourceMap: !!sourceMap, inlineSources: sourceMap},
    include: pkgs.reduce((ds, p) => ds.concat(p.dirs.map(d => join(d, "*.ts"))), [] as string[])
      .concat(extra).map(normalize)
  }
}

function normalize(path: string) {
  return path.replace(/\\/g, "/")
}

class Output {
  files: {[name: string]: string} = Object.create(null)
  changed: string[] = []
  watchers: ((changed: readonly string[]) => void)[] = []
  watchTimeout: any = null

  constructor() { this.write = this.write.bind(this) }

  write(path: string, content: string) {
    let norm = normalize(path)
    if (this.files[norm] == content) return
    this.files[norm] = content
    if (!this.changed.includes(path)) this.changed.push(path)
    if (this.watchTimeout) clearTimeout(this.watchTimeout)
    if (this.watchers.length) this.watchTimeout = setTimeout(() => {
      this.watchers.forEach(w => w(this.changed))
      this.changed = []
    }, 100)
  }

  get(path: string) {
    return this.files[normalize(path)]
  }
}

function readAndMangleComments(dirs: readonly string[], options: BuildOptions) {
  return (name: string) => {
    let file = ts.sys.readFile(name)
    if (file && dirs.includes(dirname(name)))
      file = file.replace(/(?<=^|\n)(?:([ \t]*)\/\/\/.*\n)+/g, (comment, space) => {
        if (options.expandLink)
          comment = comment.replace(/\]\(#((?:[^()]|\([^()]*\))+)\)/g, (m, anchor) => {
            let result = options.expandLink!(anchor)
            return result ? `](${result})` : m
          })
        return `${space}/**\n${space}${comment.slice(space.length).replace(/\/\/\/ ?/g, "")}${space}*/\n`
      })
    return file
  }
}

function runTS(dirs: readonly string[], tsconfig: any, options: BuildOptions) {
  let config = ts.parseJsonConfigFileContent(tsconfig, ts.sys, dirname(dirs[0]))
  let host = ts.createCompilerHost(config.options)
  host.readFile = readAndMangleComments(dirs, options)
  let program = ts.createProgram({rootNames: config.fileNames, options: config.options, host})
  let out = new Output, result = program.emit(undefined, out.write)
  return result.emitSkipped ? null : out
}

const tsFormatHost = {
  getCanonicalFileName: (path: string) => path,
  getCurrentDirectory: ts.sys.getCurrentDirectory,
  getNewLine: () => "\n"
}

function watchTS(dirs: readonly string[], tsconfig: any, options: BuildOptions) {
  let out = new Output, mangle = readAndMangleComments(dirs, options)
  let dummyConf = join(dirname(dirname(dirs[0])), "TSCONFIG.json")
  ts.createWatchProgram(ts.createWatchCompilerHost(
    dummyConf,
    undefined,
    Object.assign({}, ts.sys, {
      writeFile: out.write,
      readFile: (name: string) => {
        return name == dummyConf ? JSON.stringify(tsconfig) : mangle(name)
      }
    }),
    ts.createEmitAndSemanticDiagnosticsBuilderProgram,
    diag => console.error(ts.formatDiagnostic(diag, tsFormatHost)),
    diag => console.info(ts.flattenDiagnosticMessageText(diag.messageText, "\n"))
  ))
  return out
}

function external(id: string) { return id != "tslib" && !/^(\.?\/|\w:)/.test(id) }

function outputPlugin(output: Output, ext: string, base: Plugin) {
  let {resolveId, load} = base
  return {
    ...base,
    resolveId(source: string, base: string | undefined, options: any) {
      let full = base && source[0] == "." ? resolve(dirname(base), source) : source
      if (!/\.\w+$/.test(full)) full += ext
      if (output.get(full)) return full
      return resolveId instanceof Function ? resolveId.call(this, source, base, options) : undefined
    },
    load(file: string) {
      let code = output.get(file)
      return code ? {code, map: output.get(file + '.map')} : (load instanceof Function ? load.call(this, file) : undefined)
    }
  } as Plugin
}

const pure = "/*@__PURE__*/"

function addPureComments(code: string) {
  let patches: {from: number, to?: number, insert: string}[] = []
  function walkCall(node: any, c: (node: Node, state?: any) => void) {
    node.arguments.forEach((n: any) => c(n))
    c(node.callee)
  }
  function addPure(pos: number) {
    let last = patches.length ? patches[patches.length - 1] : null
    if (!last || last.from != pos || last.insert != pure)
      patches.push({from: pos, insert: pure})
  }

  recursive(parse(code, {ecmaVersion: 2020, sourceType: "module"}), null, {
    CallExpression(node: any, _s, c) {
      walkCall(node, c)
      let m
      addPure(node.start)
      // TS-style enum
      if (node.callee.type == "FunctionExpression" && node.callee.params.length == 1 &&
          (m = /\bvar (\w+);\s*$/.exec(code.slice(node.start - 100, node.start))) &&
          m[1] == node.callee.params[0].name) {
        patches.push({from: m.index + 4 + m[1].length + (node.start - 100), to: node.start, insert: " = "})
        patches.push({from: node.callee.body.end - 1, insert: "return " + m[1]})
      }
    },
    NewExpression(node, _s, c) {
      walkCall(node, c)
      addPure(node.start)
    },
    Function() {},
    Class() {}
  })
  patches.sort((a, b) => a.from - b.from)
  for (let pos = 0, i = 0, result = "";; i++) {
    let next = i == patches.length ? null : patches[i]
    let nextPos = next ? next.from : code.length
    result += code.slice(pos, nextPos)
    if (!next) return result
    result += next.insert
    pos = next.to ?? nextPos
  }
}

async function emit(bundle: RollupBuild, conf: any, makePure = false) {
  let result = await bundle.generate(conf)
  let dir = dirname(conf.file)
  await fs.promises.mkdir(dir, {recursive: true}).catch(() => null)
  for (let file of result.output) {
    let content = (file as any).code || (file as any).source
    if (makePure) content = addPureComments(content)
    let sourceMap: SourceMap = (file as any).map
    if (sourceMap) {
      content = content + `\n//# sourceMappingURL=${file.fileName}.map`
      await fs.promises.writeFile(join(dir, file.fileName + ".map"), sourceMap.toString())
    }
    await fs.promises.writeFile(join(dir, file.fileName), content)
  }
}

async function bundle(pkg: Package, compiled: Output, options: BuildOptions) {
  let base = await Promise.resolve(options.outputPlugin && options.outputPlugin(pkg.root) || {name: "dummy"})
  let bundle = await rollup({
    input: pkg.main.replace(/\.ts$/, ".js"),
    external,
    plugins: [
      outputPlugin(compiled, ".js", base)
    ]
  })
  let dist = join(pkg.root, "dist")
  // makePure set to false when generating source map since this manipulates output after source map is generated
  let bundleName = options.bundleName || "index"
  await emit(bundle, {
    format: "esm",
    file: join(dist, bundleName + ".js"),
    externalLiveBindings: false,
    sourcemap: options.sourceMap
  }, options.pureTopCalls && !options.sourceMap)

  await emit(bundle, {
    format: "cjs",
    file: join(dist, bundleName + ".cjs"),
    sourcemap: options.sourceMap,
    plugins: options.cjsOutputPlugin ? [options.cjsOutputPlugin(pkg.root)] : []
  })

  let tscBundle = await rollup({
    input: pkg.main.replace(/\.ts$/, ".d.ts"),
    external,
    plugins: [outputPlugin(compiled, ".d.ts", {name: "dummy"}), dts()],
    onwarn(warning, warn) {
      if (warning.code != "CIRCULAR_DEPENDENCY" && warning.code != "UNUSED_EXTERNAL_IMPORT")
        warn(warning)
    }
  })
  await emit(tscBundle, {
    format: "esm",
    file: join(dist, bundleName + ".d.ts")
  })
  await emit(tscBundle, {
    format: "esm",
    file: join(dist, bundleName + ".d.cts")
  })
}

function allDirs(pkgs: readonly Package[]) {
  return pkgs.reduce((a, p) => a.concat(p.dirs), [] as string[])
}

/// Build the package with main entry point `main`, or the set of
/// packages with the given entry point files. Output files will be
/// written to the `dist` directory one level up from the entry file.
/// Any TypeScript files in a `test` directory one level up from main
/// files will be built in-place.
export async function build(main: string | readonly string[], options: BuildOptions = {}): Promise<boolean> {
  let pkgs = typeof main == "string" ? [Package.get(main)] : main.map(Package.get)
  let compiled = runTS(allDirs(pkgs), configFor(pkgs, undefined, options), options)
  if (!compiled) return false
  for (let pkg of pkgs) {
    await bundle(pkg, compiled, options)
    for (let file of pkg.tests.map(f => f.replace(/\.ts$/, ".js")))
      fs.writeFileSync(file, compiled.get(file))
  }
  return true
}

/// Build the given packages, along with an optional set of extra
/// files, and keep rebuilding them every time an input file changes.
export function watch(mains: readonly string[], extra: readonly string[] = [], options: BuildOptions = {}): void {
  let extraNorm = extra.map(normalize)
  let pkgs = mains.map(Package.get)
  let out = watchTS(allDirs(pkgs), configFor(pkgs, extra, options), options)
  out.watchers.push(writeFor)
  writeFor(Object.keys(out.files))

  async function writeFor(files: readonly string[]) {
    let changedPkgs: Package[] = [], changedFiles: string[] = []
    for (let file of files) {
      let ts = file.replace(/\.d\.ts$|\.js$|\.js.map$/, ".ts")
      if (extraNorm.includes(ts)) {
        changedFiles.push(file)
      } else {
        let root = dirname(dirname(file))
        let pkg = pkgs.find(p => normalize(p.root) == root)
        if (!pkg)
          throw new Error("No package found for " + file)
        if (pkg.tests.includes(ts)) changedFiles.push(file)
        else if (!changedPkgs.includes(pkg)) changedPkgs.push(pkg)
      }
    }
    for (let file of changedFiles) if (/\.(js|map)$/.test(file)) fs.writeFileSync(file, out.get(file))
    if (options.onRebuildStart) options.onRebuildStart(pkgs.map(p => p.root))
    else console.log("Bundling " + pkgs.map(p => basename(p.root)).join(", "))
    for (let pkg of changedPkgs) {
      try { await bundle(pkg, out, options) }
      catch(e) { console.error(`Failed to bundle ${basename(pkg.root)}:\n${e}`) }
    }
    if (options.onRebuildEnd) options.onRebuildEnd(pkgs.map(p => p.root))
    else console.log("Bundling done.")
  }
}
