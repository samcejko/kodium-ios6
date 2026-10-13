// The diff algorithm on the iPad 2, in the editor's worker and in the page (vite.config.mjs and build-workers.mjs both
// use it): two files of 800 lines took more than the 5 s VS Code allows - and then showed as changed throughout. Their
// lines were aligned by dynamic programming (1,600 lines in all: 640,000 cells) in three plain arrays of 640,000
// elements, which the old JavaScriptCore keeps as hash tables (an array that long is sparse to it), and the time was
// asked of the clock at every cell. The tables are typed arrays now (8, 1 and 4 bytes a cell), the clock is asked every
// 256 cells, and dynamic programming aligns the lines of files of up to 700 lines in all (VS Code: 1,700); bigger ones
// go by Myers' algorithm, as VS Code's do above its limit - at most 122,000 cells, 1.6 MB.
export function quickerDiffs() {
  const edits = {
    '/vs/editor/common/diff/defaultLinesDiffComputer/utils.js': [
      ['class Array2D {\n    constructor(width, height) {\n        this.width = width;\n        this.height = height;\n        this.array = [];\n        this.array = ( new Array(width * height));\n',
       'class Array2D {\n    constructor(width, height, kdType) {\n        this.width = width;\n        this.height = height;\n        this.array = [];\n        this.array = ( new (kdType || Array)(width * height));\n']],
    '/vs/editor/common/diff/defaultLinesDiffComputer/algorithms/dynamicProgrammingDiffing.js': [
      ['        const lcsLengths = ( new Array2D(sequence1.length, sequence2.length));\n' +
       '        const directions = ( new Array2D(sequence1.length, sequence2.length));\n' +
       '        const lengths = ( new Array2D(sequence1.length, sequence2.length));\n',
       '        const lcsLengths = ( new Array2D(sequence1.length, sequence2.length, Float64Array));\n' +
       '        const directions = ( new Array2D(sequence1.length, sequence2.length, Uint8Array));\n' +
       '        const lengths = ( new Array2D(sequence1.length, sequence2.length, Int32Array));\n'],
      ['                if (!timeout.isValid()) {\n                    return DiffAlgorithmResult.trivialTimedOut(sequence1, sequence2);\n                }\n',
       '                if ((s2 & 255) === 0 && !timeout.isValid()) {\n                    return DiffAlgorithmResult.trivialTimedOut(sequence1, sequence2);\n                }\n']],
    '/vs/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js': [
      ['            if (sequence1.length + sequence2.length < 1700) {\n', '            if (sequence1.length + sequence2.length < 700) {\n']]
  }
  return {
    name: 'kodium-quicker-diffs',
    transform(code, id) {
      const p = id.replace(/\\/g, '/')
      const suffix = Object.keys(edits).find((s) => p.endsWith(s))
      if (!suffix) return null
      for (const [find, replace] of edits[suffix]) {
        if (code.split(find).length !== 2) this.error('kodium-quicker-diffs: ' + suffix + ' has another form')
        code = code.replace(find, () => replace)
      }
      return { code, map: null }
    }
  }
}
