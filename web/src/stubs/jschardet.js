// Stands in for jschardet (LGPL), which VS Code loads only to guess the encoding of a file when the setting
// files.autoGuessEncoding is on. Here it never guesses: files open in the configured encoding (UTF-8).
export function detect() {
  return null
}
export function detectAll() {
  return []
}
export default { detect, detectAll }
