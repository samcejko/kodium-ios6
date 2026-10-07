// js-beautify's browser build (the package's main brings its command line's Node modules)
declare module 'js-beautify/js/lib/beautify.js' {
  const beautify: { js_beautify: (code: string, options?: Record<string, unknown>) => string }
  export default beautify
}
