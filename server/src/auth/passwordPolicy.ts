export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

// Commonly used passwords that are >= PASSWORD_MIN characters (shorter ones fail on length anyway).
const COMMON = new Set([
  '1234567890', '0123456789', '12345678910', '123456789012', '1234567890a', '123456789a', 'a123456789',
  'a1234567890', '1234512345', '123123123123', '1111111111', '11111111111', '0000000000', '9876543210',
  '1q2w3e4r5t', 'q1w2e3r4t5', '1qaz2wsx3edc', 'qazwsxedcrfv', 'qazwsxedc123', 'zxcvbnm123', 'zxcvbnmasdf',
  'qwertyuiop', 'qwertyuiop123', 'qwerty1234', 'qwerty12345', 'qwerty123456', 'qwertyuiopasdfghjkl', 'qwer123456',
  '1234qwer12', 'asdfghjkl1', 'asdfasdf12', 'asdf123456', 'asdfghjk12', 'abcd123456', 'abc1234567', 'abcdefghij',
  'abcdefg123', 'abcdef1234', '123456abcd',
  'password12', 'password123', 'password1234', 'password12345', 'password123456', 'password01', 'password!23',
  'password1!', 'password2024', 'password2025', 'password2026', 'passw0rd123', 'p@ssw0rd123', 'p@ssword123',
  'p@ssw0rd!23', 'passwordpassword', 'mypassword', 'mypassword1', 'mypassword123', 'letmein123', 'letmein1234',
  'welcome123', 'welcome1234', 'welcome12345', 'admin12345', 'admin123456', 'administrator', 'changeme123',
  'changemenow', 'testtest12', 'test123456', 'test1234567', 'user123456', 'guest12345', 'default123',
  'secret1234', 'iloveyou12', 'iloveyou123', 'iloveyou1234', 'monkey1234', 'dragon1234', 'football123',
  'football12', 'baseball123', 'baseball12', 'superman123', 'batman1234', 'trustno1234', 'sunshine123',
  'princess123', 'charlie123', 'shadow1234', 'master1234', 'michael123', 'jennifer123', 'jordan23456',
  'starwars123', 'pokemon123', 'computer123', 'internet123', 'whatever123', 'freedom123', 'liverpool1',
  'chocolate1', 'summer2024', 'summer2025', 'winter2024', 'winter2025', 'israel1234', 'israel12345',
  'shalom1234', 'shalom12345', 'ahavatam123', 'ahavatam12',
]);

/** Returns a Hebrew error message, or null when the password is acceptable. Length only - no composition rules. */
export function checkPassword(password: string, email?: string): string | null {
  const len = [...password].length;
  if (len < PASSWORD_MIN) return `הסיסמה קצרה מדי (לפחות ${PASSWORD_MIN} תווים)`;
  if (len > PASSWORD_MAX) return `הסיסמה ארוכה מדי (עד ${PASSWORD_MAX} תווים)`;
  const lower = password.toLowerCase();
  if (email && lower === email.toLowerCase()) return 'הסיסמה לא יכולה להיות זהה לכתובת האימייל';
  if (COMMON.has(lower)) return 'הסיסמה נפוצה מדי, בחרו סיסמה אחרת';
  return null;
}
