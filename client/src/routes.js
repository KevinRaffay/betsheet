const POSITIVE_ID = /^\d+$/;

export function parseRoute(pathname) {
  const parts = String(pathname || '/').split('/').filter(Boolean);
  if (parts.length === 0) return { name: 'list' };
  if (parts.length === 1 && parts[0] === 'new') return { name: 'new' };
  if (parts.length === 1 && parts[0] === 'pl') return { name: 'pl' };
  if (parts.length === 1 && parts[0] === 'simulate') return { name: 'sim' };
  if (parts.length === 2 && ['day', 'card'].includes(parts[0]) && POSITIVE_ID.test(parts[1])) {
    const id = Number(parts[1]);
    if (Number.isSafeInteger(id) && id > 0) {
      return parts[0] === 'day'
        ? { name: 'day', id }
        : { name: 'card', id };
    }
  }
  return { name: 'list' };
}

export function pathForView(view) {
  if (view.name === 'new') return '/new';
  if (view.name === 'pl') return '/pl';
  if (view.name === 'sim') return '/simulate';
  if (view.name === 'day' && Number.isSafeInteger(view.id) && view.id > 0) return `/day/${view.id}`;
  if (view.name === 'card' && Number.isSafeInteger(view.id) && view.id > 0) return `/card/${view.id}`;
  return '/';
}