import type { FaceDetection } from "@shared/types";

/**
 * Read-only overlay drawing the worker's face detections on top of the loupe
 * image: one box per face (coloured by eyes-open score) plus a dot at each
 * detected eye centre.
 *
 * Like CropOverlay it takes the displayed image's bounding rect (post
 * object-contain) and maps the normalised 0..1 detection coords into pixels,
 * so it stays glued to the photo regardless of letterboxing. Shown only in
 * fit view — the parent hides it while zoomed so the untransformed box math
 * stays valid.
 */

interface Props {
  imageBox: { left: number; top: number; width: number; height: number };
  faces: FaceDetection[];
}

// Null eyes_open = face detected but not eye-scored (heavy profile, etc.) — draw
// it neutrally rather than as a "closed eyes" reject.
function tierBorder(eyesOpen: number | null): string {
  if (eyesOpen == null) return "border-muted";
  return eyesOpen >= 7 ? "border-pick" : eyesOpen >= 4 ? "border-yellow-300" : "border-reject";
}

function tierBg(eyesOpen: number | null): string {
  if (eyesOpen == null) return "bg-muted";
  return eyesOpen >= 7 ? "bg-pick" : eyesOpen >= 4 ? "bg-yellow-300" : "bg-reject";
}

const EYE_DOT = 7;

export function FacesOverlay({ imageBox, faces }: Props) {
  return (
    <div className="absolute inset-0 pointer-events-none">
      {faces.map((f, i) => {
        const [x, y, w, h] = f.box;
        const left = imageBox.left + x * imageBox.width;
        const top = imageBox.top + y * imageBox.height;
        const width = w * imageBox.width;
        const height = h * imageBox.height;
        const eyes = [f.left_eye, f.right_eye].filter(
          (e): e is [number, number] => e != null,
        );
        return (
          <div key={i}>
            <div
              className={`absolute border-2 ${tierBorder(f.eyes_open)} rounded-sm`}
              style={{ left, top, width, height }}
            >
              <span
                className="absolute -top-4 left-0 px-1 rounded-sm text-[10px] font-mono
                  font-semibold bg-black/70 text-ink whitespace-nowrap"
                title="Eyes-open score (0–10)"
              >
                eyes {f.eyes_open == null ? "—" : f.eyes_open.toFixed(1)}
              </span>
            </div>
            {eyes.map(([ex, ey], j) => (
              <div
                key={j}
                className={`absolute rounded-full ring-1 ring-black/70 ${tierBg(f.eyes_open)}`}
                style={{
                  left: imageBox.left + ex * imageBox.width - EYE_DOT / 2,
                  top: imageBox.top + ey * imageBox.height - EYE_DOT / 2,
                  width: EYE_DOT,
                  height: EYE_DOT,
                }}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}
