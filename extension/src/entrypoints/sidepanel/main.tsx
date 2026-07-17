import { createRoot } from 'react-dom/client';
import { App } from '@/ui/App';
import '@/ui/styles.css';

const el = document.getElementById('root');
if (el) {
  createRoot(el).render(
    <div className="leo-root">
      <App surface="panel" />
    </div>,
  );
}
