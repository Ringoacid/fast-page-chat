// Positions refer to the original saved text, never to previously annotated text.
// Missing positions (including older histories) must not imply a location.
export function pageWithImageMarkers(page, images = []) {
  if (!images.length) return { ...page };
  const locations = images.map((image, index) => ({
    id: index + 1,
    offset: Number.isInteger(image.position) && image.position >= 0 && image.position <= page.text.length ? image.position : null
  }));
  let text = '', cursor = 0;
  for (const location of locations.filter(l => l.offset !== null).sort((a, b) => a.offset - b.offset || a.id - b.id)) {
    text += page.text.slice(cursor, location.offset) + `\n\n[画像${location.id}]\n\n`;
    cursor = location.offset;
  }
  text += page.text.slice(cursor);
  return { ...page, text, imageLocations: locations.map(l => ({ id: l.id, positionKnown: l.offset !== null })) };
}
