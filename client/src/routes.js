const POSITIVE_ID = /^\d+$/;

export function parseRoute(pathname) {
  const parts = String(pathname || '/').split('/').filter(Boolean);
  if (parts.length === 0) return { name: 'list' };
  if (parts.length === 1 && parts[0] === 'new') return { name: 'new' };
  if (parts.length === 1 && parts[0] === 'pl') return { name: 'pl' };
  if (parts.length === 1 && parts[0] === 'simulate') return { name: 'sim' };
  if (parts.length === 1 && parts[0] === 'backfill') return { name: 'backfill' };
  if (parts.length === 1 && parts[0] === 'distribution') return { name: 'distribution' };
  if (parts.length === 1 && parts[0] === 'replay') return { name: 'replay' };
  if (parts.length === 2 && parts[0] === 'replay' && parts[1] === 'standing') return { name: 'replayStanding' };
  if (parts.length === 3 && parts[0] === 'replay' && parts[1] === 'day' && POSITIVE_ID.test(parts[2])) {
    const id = Number(parts[2]);
    if (Number.isSafeInteger(id) && id > 0) return { name: 'replayDay', id };
  }
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
  if (view.name === 'backfill') return '/backfill';
  if (view.name === 'distribution') return '/distribution';
  if (view.name === 'replay') return '/replay';
  if (view.name === 'replayStanding') return '/replay/standing';
  if (view.name === 'replayDay' && Number.isSafeInteger(view.id) && view.id > 0) return `/replay/day/${view.id}`;
  if (view.name === 'day' && Number.isSafeInteger(view.id) && view.id > 0) return `/day/${view.id}`;
  if (view.name === 'card' && Number.isSafeInteger(view.id) && view.id > 0) return `/card/${view.id}`;
  return '/';
}