import * as path from 'path'
import * as url from 'url'
import { AngularWebpackPlugin } from '@ngtools/webpack'

const __dirname = url.fileURLToPath(new URL('.', import.meta.url))

export default () => ({
  target: 'node',
  entry: 'src/index.ts',
  context: __dirname,
  devtool: 'source-map',
  mode: 'development',
  optimization: {
    minimize: false,
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'index.js',
    pathinfo: true,
    libraryTarget: 'umd',
    devtoolModuleFilenameTemplate: 'webpack-tabby-ai:///[resource-path]',
  },
  resolve: {
    modules: ['.', 'src', 'node_modules'].map(x => path.join(__dirname, x)),
    extensions: ['.ts', '.js'],
    // Prefer Angular's ES module entry points so the Ivy linker sees partial-compiled code.
    mainFields: ['esm2020', 'es2020', 'esm2015', 'browser', 'module', 'main'],
  },
  module: {
    rules: [
      // @ngtools/webpack compiles @NgModule/@Component decorators into Ivy static
      // defs (ɵmod/ɵinj) via the Angular compiler. Plain ts-loader would emit a
      // runtime reflect-metadata decorator that Tabby's AOT host cannot load
      // ("needs to be compiled using the JIT compiler" error).
      {
        test: /\.ts$/,
        use: [
          {
            loader: '@ngtools/webpack',
          },
        ],
      },
      {
        test: /\.scss$/,
        use: ['style-loader', 'css-loader', 'sass-loader'],
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader'],
      },
    ],
  },
  plugins: [
    new AngularWebpackPlugin({
      tsconfig: path.resolve(__dirname, 'tsconfig.json'),
      directTemplateLoading: false,
      jitMode: true,
    }),
  ],
  // Only the Tabby host framework, Electron, and Node built-ins are externalized.
  // Anything declared in package.json "dependencies" (e.g. a future AI SDK) is NOT
  // listed here, so webpack bundles it into dist/index.js.
  externals: [
    'fs',
    'os',
    'path',
    'net',
    'stream',
    'readline',
    'child_process',
    'electron',
    '@electron/remote',
    'ngx-toastr',
    /^@angular(?!\/common\/locales)/,
    /^@ng-bootstrap/,
    /^rxjs/,
    /^tabby-/,
  ],
})
