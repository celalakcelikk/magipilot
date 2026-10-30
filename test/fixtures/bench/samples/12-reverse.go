package textutil

import (
	"strings"
	"unicode"
)

// Reverse returns s with its runes in reverse order.
func Reverse(s string) string {
	runes := []rune(s)
	for i, j := 0, len(runes)-1; i < j; i, j = i+1, j-1 {
		<FILL>runes[i], runes[j] = runes[j], runes[i]</FILL>
	}
	return string(runes)
}

// IsPalindrome reports whether s reads the same backwards, ignoring case and non-letters.
func IsPalindrome(s string) bool {
	var b strings.Builder
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(unicode.ToLower(r))
		}
	}
	cleaned := b.String()
	return cleaned == Reverse(cleaned)
}
