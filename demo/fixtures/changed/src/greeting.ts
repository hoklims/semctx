export function greetingFor(name: string): string {
  // Trim first: a trailing newline pasted from a form field should not leak into the greeting.
  return `Hello, ${name.trim()}!`;
}
