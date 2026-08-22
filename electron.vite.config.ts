import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import obfuscator from 'rollup-plugin-obfuscator'

const isProduction = process.env.NODE_ENV === 'production' || process.argv.includes('build')

// High-Grade AST Obfuscation & String Virtualization (Optimized for Bundlers)
const obfuscatorOptions = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.5,
  deadCodeInjection: false, // Prevent AST inflation in bundle
  debugProtection: false,
  disableConsoleOutput: false,
  identifierNamesGenerator: 'hexadecimal' as const,
  log: false,
  numbersToExpressions: true,
  renameGlobals: false,
  rotateStringArray: true,
  selfDefending: false, // Must be false for bundled Vite code to prevent infinite loops
  shuffleStringArray: true,
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 10,
  stringArray: true,
  stringArrayCallsTransform: true,
  stringArrayCallsTransformThreshold: 0.75,
  stringArrayEncoding: ['rc4'] as ('none' | 'base64' | 'rc4')[],
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 2,
  stringArrayWrappersChainedCalls: true,
  stringArrayWrappersParametersMaxCount: 4,
  stringArrayWrappersType: 'function' as const,
  stringArrayThreshold: 0.8,
  transformObjectKeys: true,
  unicodeEscapeSequence: false
}

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin(),
      ...(isProduction
        ? [
            obfuscator({
              options: obfuscatorOptions
            })
          ]
        : [])
    ]
  },
  preload: {
    plugins: [
      externalizeDepsPlugin()
    ]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [
      react(),
      ...(isProduction
        ? [
            obfuscator({
              options: obfuscatorOptions
            })
          ]
        : [])
    ]
  }
})

