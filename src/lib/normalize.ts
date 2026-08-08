export const normalizeText = (value: string) => value.trim().normalize("NFKC").replace(/\s+/g, " ");
export const normalizeName = (value: string) => normalizeText(value).toLocaleLowerCase("en-US");
export const normalizeUsername = (value: string) => normalizeText(value).toLocaleLowerCase("en-US");

