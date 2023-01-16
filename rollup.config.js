import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";
import babel from "@rollup/plugin-babel";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";
import keysTransformer from "ts-transformer-keys/transformer";
import isBuiltin from "is-builtin-module";

let env = process.env.BUILD_TYPE;
if (env.indexOf("debug") !== 0 && env.indexOf("release") !== 0) {
    console.error("Bad environment set", env);
    process.exit(1);
}

const release = env.indexOf("release") === 0;

if (release) {
    process.env.BABEL_REMOVE = "trace,verbose,assert,pushDebugGroup,popDebugGroup";
}

const plugins = [
    resolve({
        resolveOnly: (module) => module === "string_decoder" || !isBuiltin(module),
        preferBuiltins: false,
        exportConditions: ['node'],
    }),
    json(),
    commonjs(),
    typescript({
        tsconfig: `tsconfig.json`,
        cacheDir: ".cache",
        transformers: [service => ({
            before: [ keysTransformer(service.getProgram()) ],
            after: []
        })]
    }),
    babel({
        exclude: "node_modules/**",
        babelrc: false,
        inputSourceMap: true,
        sourceMaps: true,
        babelHelpers: "bundled",
        extensions: [".js", ".ts"],
        presets: [
            ["@babel/preset-env", {
                loose: true,
                targets: {
                    chrome: "87"
                },
                modules: false,
                useBuiltIns: "entry",
                corejs: 3,
                exclude: [
                    "@babel/plugin-transform-async-to-generator",
                    "@babel/plugin-transform-regenerator"
                ]
            }]
        ],
        plugins: [
            ...(release ? ["./scripts/babel-plugin-remove"] : [])
        ]
    }),
    ...release ? [terser()] : [],
];

const postfix = release ? ".release" : "";

export default [ {
    input: "src/index.ts",
    output: {
        strict: false,
        file: `dist/index${postfix}.js`,
        format: "cjs",
        name: "main",
        exports: "named",
        sourcemap: true,
    },
    plugins,
    onwarn(warning, warn) {
        if (warning.code === 'THIS_IS_UNDEFINED') return;
        warn(warning);
    },
} ];
