package daemon

import (
	"cmp"
	"maps"
	"slices"
)

func sortedMapValues[K cmp.Ordered, V any](items map[K]V) []V {
	keys := slices.Sorted(maps.Keys(items))
	values := make([]V, 0, len(keys))
	for _, key := range keys {
		values = append(values, items[key])
	}
	return values
}
