// UAT data for feature 6012, the service status page.
//
// No record is needed: Mike and the owner (the seeded logins) open the page, which reads only the
// dev keys and writes nothing. Nothing is created, so nothing carries the uat-6012 label, and no
// cast record is changed.
//
// Sends nothing: no email, no text, no upload. (The page itself makes one free, read-only call to
// each outside service when the owner opens it -- that is the check.)
export function make(): Promise<string[]> {
  return Promise.resolve(["Nothing to make -- Mike and the owner open the page; it reads the dev keys only"]);
}

export function topUp(): Promise<string[]> {
  return Promise.resolve([]);
}

export function restoreCast(): Promise<void> {
  return Promise.resolve();
}
