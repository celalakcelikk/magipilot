package collections

import "errors"

var ErrEmpty = errors.New("stack is empty")

// Stack is a LIFO stack backed by a slice.
type Stack[T any] struct {
	items []T
}

func (s *Stack[T]) Push(v T) {
	s.items = append(s.items, v)
}

func (s *Stack[T]) Pop() (T, error) {
	var zero T
	if len(s.items) == 0 {
		return zero, ErrEmpty
	}
	<FILL>last := s.items[len(s.items)-1]
	s.items = s.items[:len(s.items)-1]
	return last, nil</FILL>
}

func (s *Stack[T]) Len() int {
	return len(s.items)
}
