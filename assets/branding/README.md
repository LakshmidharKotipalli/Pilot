# WebPilot logo: robotic fist pointing a cursor at a screen

The active identity is a complete blue robotic fist holding a white cursor, aimed at a target inside a browser window. This represents an AI assistant taking browser actions. Generated with the built-in imagegen tool, then exported with macOS sips, preserving alpha.

## Assets

- `webpilot-screen-master.png`: current high-resolution transparent master.
- `../../public/icons/webpilot-{16,32,48,128}.png`: runtime exports.
- `webpilot-fist-master.png`: earlier fist-only concept, also the image reference for the final generation.
- `webpilot-master.png` and `webpilot-toolbar-master.png`: earlier pilot mascot concepts, retained for reference only.

Only the runtime exports ship in the extension. The header uses the 128 px export at 28 CSS pixels alongside real WebPilot text. Notifications also use 128 px. The toolbar uses 16 and 32 px.

## Final generation prompt

Use case: logo-brand.
Refine the supplied WebPilot closed robotic fist holding a cursor logo so it clearly looks like the cursor is POINTING TO A TARGET ON A SCREEN.
Retain the complete closed cobalt robotic fist in the lower right, four curled fingers together, thumb crossing them, short wrist, gripping the white cursor stem. Retain the classic white mouse cursor arrow pointing upper left, navy outline.
Add a VERY SIMPLE compact browser-screen outline BEHIND AND ABOVE the cursor, occupying the upper-left region. Rounded rectangular browser window, bold cobalt border, a simple pale-blue title-bar line, otherwise transparent interior. Inside this screen near its upper-left-center is ONE small cobalt rounded-square UI target. Position the very tip of the held cursor precisely touching the lower-right edge of this target so the interaction is immediately clear. The cursor extends diagonally from the gripping fist outside/below the screen into this screen. Cursor and fist are foreground; screen frame behind. Keep the screen much simpler than the hand. This must be one tightly integrated square logo, not an illustration or scene. The target and visible screen frame should read at 32 pixels.
Use strong clean geometric silhouettes, flat vector-like graphic identity, cobalt #2B59FF, navy #14244A, pale blue #DCEBFF, white. Make the fist slightly smaller than in the reference so screen and target have breathing room. Bold finger separations. No tiny mechanical details, realistic anatomy, glow, lighting, gradients, textures, drop shadows, sparkle, motion trails, text, letters, wallpaper or mockup. Transparent alpha everywhere outside the logo and inside the screen except target and minimal title bar. Square high-resolution canvas with generous 8 percent margins, ONE logo centered. Cursor tip must visibly point at the UI target, not into empty space.

## Re-export

Run from the repository root on macOS:

```sh
for size in 16 32 48 128; do
  sips -z "$size" "$size" assets/branding/webpilot-screen-master.png --out "public/icons/webpilot-$size.png"
done
```
