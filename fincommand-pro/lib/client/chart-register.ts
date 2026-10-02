import {
  Chart as ChartJS, CategoryScale, LinearScale, BarElement, LineElement, PointElement, ArcElement, Tooltip, Legend, Filler,
  BarController, LineController,
} from 'chart.js';

// Register components immediately at module load. Filler is required by
// Sparkline.tsx's `fill: true` area charts — without it Chart.js silently
// skips the fill (no error, just a missing visual) and logs a console
// warning on every single render.
// Both controllers are registered explicitly so a mixed chart (bars with a
// line series overlaid, see widget-renderers.tsx) never depends on some other
// component having happened to import the matching typed chart first.
ChartJS.register(CategoryScale, LinearScale, BarElement, LineElement, PointElement, ArcElement, Tooltip, Legend, Filler, BarController, LineController);

export function ensureChartsRegistered(): void {
  // Kept for backward compatibility with components calling it
}

