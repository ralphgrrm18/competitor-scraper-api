export interface Coords {
  lat: number;
  lng: number;
  displayName: string;
}

export async function geocodeLocation(location: string): Promise<Coords> {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(location)}&format=json&limit=1&addressdetails=0`;

  const res = await fetch(url, {
    headers: {
      // Nominatim requires a descriptive User-Agent with contact info
      "User-Agent": "CompetitorAnalysisTool/1.0 (ralph@ringringmarketing.com)",
      "Accept-Language": "en",
    },
  });

  if (!res.ok) throw new Error(`Nominatim error: ${res.status}`);

  const data = (await res.json()) as Array<{
    lat: string;
    lon: string;
    display_name: string;
  }>;

  if (!data.length) throw new Error(`Could not geocode "${location}"`);

  return {
    lat: parseFloat(data[0].lat),
    lng: parseFloat(data[0].lon),
    displayName: data[0].display_name,
  };
}
