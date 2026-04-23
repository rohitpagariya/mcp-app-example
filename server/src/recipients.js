// Hard-coded "directory" used by search_recipients + send_message.
// In a real deployment this is Microsoft Graph /me/people.

export const recipients = [
  {
    displayName: 'Babak Shammas',
    email: 'babak@contoso.com',
    initials: 'BS',
    color: '#8764B8',
  },
  {
    displayName: 'Satya Nadella',
    email: 'satyan@contoso.com',
    initials: 'SN',
    color: '#0078D4',
  },
  {
    displayName: 'Kevin Scott',
    email: 'kevinsc@contoso.com',
    initials: 'KS',
    color: '#107C10',
  },
  {
    displayName: 'Mira Murati',
    email: 'miram@contoso.com',
    initials: 'MM',
    color: '#D83B01',
  },
  {
    displayName: 'Rohit Pagariya',
    email: 'rohitpag@microsoft.com',
    initials: 'RP',
    color: '#5B5FC7',
  },
];

export function searchRecipients(query) {
  if (!query) return recipients.slice(0, 5);
  const q = query.toLowerCase();
  return recipients.filter(
    (r) =>
      r.displayName.toLowerCase().includes(q) ||
      r.email.toLowerCase().includes(q),
  );
}

export function resolveRecipient(toNameOrEmail) {
  if (!toNameOrEmail) return null;
  const q = toNameOrEmail.toLowerCase();
  return (
    recipients.find((r) => r.email.toLowerCase() === q) ||
    recipients.find((r) => r.displayName.toLowerCase() === q) ||
    recipients.find((r) => r.displayName.toLowerCase().includes(q)) ||
    null
  );
}
