// Stands in for xterm.js's addons that iOS 6's web view cannot use: WebGL drawing (no WebGL there), images (sixel/iTerm,
// drawn on canvases the size of the terminal) and font ligatures (they read the font files through Node). VS Code loads
// them only when a setting asks (terminal.integrated.gpuAcceleration, enableImages, fontLigatures.enabled): then the
// terminal is told that the addon is not there, and it draws as it does without it.
class Unavailable {
  constructor() {
    throw new Error('This terminal addon is not available on iOS 6')
  }
}
export const WebglAddon = Unavailable
export const ImageAddon = Unavailable
export const LigaturesAddon = Unavailable
