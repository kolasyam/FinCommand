import {
  Chart as ChartJS, CategoryScale, LinearScale, BarElement, LineElement, PointElement, ArcElement, Tooltip, Legend,
} from 'chart.js';

// Register components immediately at module load
ChartJS.register(CategoryScale, LinearScale, BarElement, LineElement, PointElement, ArcElement, Tooltip, Legend);

export function ensureChartsRegistered(): void {
  // Kept for backward compatibility with components calling it
}

