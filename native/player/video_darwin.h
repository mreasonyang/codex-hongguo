#include <stdint.h>
typedef struct { double position, duration, rate, volume; int ready, failed, muted; } HGStatus;
uintptr_t HGCreate(uintptr_t window);
void HGLoad(uintptr_t player, const char *url);
void HGApply(uintptr_t player,double position,double rate,double volume,int paused,int muted,int seek);
HGStatus HGRead(uintptr_t player);
void HGFrame(uintptr_t player,double x,double y,double width,double height);
void HGHidden(uintptr_t player,int hidden);
void HGDispose(uintptr_t player);
int HGMousePressed(void);
int HGHostAt(double x,double y,uintptr_t ownWindow);
