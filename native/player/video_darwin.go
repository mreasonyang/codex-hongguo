//go:build darwin

package main

/*
#cgo CFLAGS: -fobjc-arc
#cgo LDFLAGS: -framework AppKit -framework AVFoundation -framework QuartzCore -framework CoreMedia
#include <stdlib.h>
#include "video_darwin.h"
*/
import "C"
import "unsafe"

type mediaStatus struct {
	position, duration, rate, volume float64
	ready, failed, muted             bool
}

func createVideo(window uintptr) uintptr { return uintptr(C.HGCreate(C.uintptr_t(window))) }
func loadVideo(p uintptr, url string) {
	s := C.CString(url)
	defer C.free(unsafe.Pointer(s))
	C.HGLoad(C.uintptr_t(p), s)
}
func applyVideo(p uintptr, s Snapshot, seek bool) {
	C.HGApply(C.uintptr_t(p), C.double(float64(s.Position)/1000), C.double(s.Rate), C.double(s.Volume), boolean(s.Paused), boolean(s.Muted), boolean(seek))
}
func readVideo(p uintptr) mediaStatus {
	s := C.HGRead(C.uintptr_t(p))
	return mediaStatus{float64(s.position), float64(s.duration), float64(s.rate), float64(s.volume), s.ready != 0, s.failed != 0, s.muted != 0}
}
func frameVideo(p uintptr, x, y, w, h float32) {
	C.HGFrame(C.uintptr_t(p), C.double(x), C.double(y), C.double(w), C.double(h))
}
func hideVideo(p uintptr, hidden bool) { C.HGHidden(C.uintptr_t(p), boolean(hidden)) }
func disposeVideo(p uintptr)           { C.HGDispose(C.uintptr_t(p)) }
func mousePressed() bool               { return C.HGMousePressed() != 0 }
func hostAt(x, y int, w uintptr) bool {
	return C.HGHostAt(C.double(x), C.double(y), C.uintptr_t(w)) != 0
}
func boolean(b bool) C.int {
	if b {
		return 1
	}
	return 0
}
