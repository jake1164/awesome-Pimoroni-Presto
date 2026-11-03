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
