// `category` is a category slug, or null for no category filter. Null (not a slug such as 'all') means
// "unfiltered", so a README category named All keeps its own, independent selection.
export function filterAndSortCards(cards, { query = '', category = null, badge = '', sortBy = 'name' } = {}) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  return cards
    .filter((card) => {
      const matchesQuery = (card.dataset.search ?? '').includes(normalizedQuery);
      const matchesCategory = category === null || card.dataset.category === category;
      const badges = (card.dataset.badges ?? '').split(',');
      return matchesQuery && matchesCategory && (!badge || badges.includes(badge));
    })
    .sort((first, second) => {
      if (sortBy === 'category') {
        const categoryOrder = collator.compare(first.dataset.categoryName ?? '', second.dataset.categoryName ?? '');
        if (categoryOrder !== 0) return categoryOrder;
      }
      return collator.compare(first.dataset.title ?? '', second.dataset.title ?? '');
    });
}

export function renderResultCount(container, total) {
  const noun = total === 1 ? 'project' : 'projects';
  const strong = document.createElement('strong');
  strong.textContent = String(total);
  container.replaceChildren('Showing ', strong, ` ${noun}`);
}

// Card images are optional. A card's category icon sits underneath its image, so when an image fails (missing
// file, bad URL, blocked request) the image is hidden and the icon shows; card size and controls never change.
// The `complete && naturalWidth === 0` check covers images that failed before this script ran.
export function watchCardImages(images) {
  for (const image of images) {
    const preview = image.closest('[data-image-state]');
    const setState = (state) => {
      if (preview) preview.dataset.imageState = state;
      image.hidden = state === 'failed';
    };
    if (image.complete) {
      setState(image.naturalWidth > 0 ? 'loaded' : 'failed');
    } else {
      image.addEventListener('load', () => setState('loaded'), { once: true });
      image.addEventListener('error', () => setState('failed'), { once: true });
    }
  }
}
