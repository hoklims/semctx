export function greetingFor(name: string): string {
  // Trim so a trailing newline pasted from a form field does not leak into the greeting.
  return `Hello, ${name.trim()}!`;
}
