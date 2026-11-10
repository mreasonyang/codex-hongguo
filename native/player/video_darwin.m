//go:build darwin
#import <AppKit/AppKit.h>
#import <AVFoundation/AVFoundation.h>
#import <QuartzCore/QuartzCore.h>
#include "video_darwin.h"

@interface HGSurface:NSObject
@property AVPlayer *player;
@property AVPlayerLayer *layer;
@property NSWindow *window;
@property NSString *url;
@property double position;
@property double rate;
@property BOOL paused;
@property BOOL seeking;
@property BOOL initialSeek;
@property NSUInteger serial;
@end
@implementation HGSurface
@end
static HGSurface *surface(uintptr_t p){return (__bridge HGSurface *)(void *)p;}
uintptr_t HGCreate(uintptr_t window){
  HGSurface *s=[HGSurface new];s.window=(__bridge NSWindow *)(void *)window;
  s.player=[AVPlayer new];s.player.automaticallyWaitsToMinimizeStalling=NO;
  s.layer=[AVPlayerLayer playerLayerWithPlayer:s.player];s.layer.videoGravity=AVLayerVideoGravityResizeAspect;
  s.layer.backgroundColor=NSColor.blackColor.CGColor;s.layer.zPosition=10;
  s.window.contentView.wantsLayer=YES;[s.window.contentView.layer addSublayer:s.layer];
  return (uintptr_t)(__bridge_retained void *)s;
}
void HGLoad(uintptr_t p,const char *url){
  HGSurface *s=surface(p);NSString *value=[NSString stringWithUTF8String:url];
  if([s.url isEqualToString:value])return;
  s.url=value;s.serial++;s.seeking=NO;s.initialSeek=YES;[s.player pause];
  if(!value.length){[s.player replaceCurrentItemWithPlayerItem:nil];return;}
  AVPlayerItem *item=[AVPlayerItem playerItemWithURL:[NSURL URLWithString:value]];
  item.preferredForwardBufferDuration=5;
  [s.player replaceCurrentItemWithPlayerItem:item];
}
static void seekReady(HGSurface *s){
  if(!s.initialSeek || s.player.currentItem.status!=AVPlayerItemStatusReadyToPlay)return;
  s.initialSeek=NO;s.seeking=YES;NSUInteger serial=++s.serial;
  double duration=CMTimeGetSeconds(s.player.currentItem.duration);
  double position=isfinite(duration)?fmin(s.position,fmax(0,duration-0.05)):s.position;
  [s.player seekToTime:CMTimeMakeWithSeconds(position,600) toleranceBefore:kCMTimeZero toleranceAfter:kCMTimeZero completionHandler:^(BOOL finished){
    dispatch_async(dispatch_get_main_queue(),^{if(s.serial!=serial)return;s.seeking=NO;if(!s.paused)s.player.rate=s.rate;});
  }];
}
void HGApply(uintptr_t p,double position,double rate,double volume,int paused,int muted,int seek){
  HGSurface *s=surface(p);s.position=position;s.rate=rate;s.paused=paused;
  s.player.volume=volume;s.player.muted=muted;
  if(seek){s.initialSeek=YES;[s.player pause];}
  seekReady(s);
  if(!s.initialSeek && !s.seeking)s.player.rate=paused?0:rate;
}
HGStatus HGRead(uintptr_t p){
  HGSurface *s=surface(p);seekReady(s);
  double position=CMTimeGetSeconds(s.player.currentTime),duration=CMTimeGetSeconds(s.player.currentItem.duration);
  return (HGStatus){isfinite(position)?position:0,isfinite(duration)?duration:0,s.player.rate,s.player.volume,
    s.player.currentItem.status==AVPlayerItemStatusReadyToPlay && s.layer.readyForDisplay && !s.seeking && !s.initialSeek,
    s.player.currentItem.status==AVPlayerItemStatusFailed,s.player.muted};
}
void HGFrame(uintptr_t p,double x,double y,double width,double height){
  HGSurface *s=surface(p);[CATransaction begin];[CATransaction setDisableActions:YES];
  s.layer.frame=CGRectMake(x,NSHeight(s.window.contentView.bounds)-y-height,width,height);[CATransaction commit];
}
void HGHidden(uintptr_t p,int hidden){surface(p).layer.hidden=hidden;}
void HGDispose(uintptr_t p){HGSurface *s=CFBridgingRelease((void *)p);[s.player pause];[s.layer removeFromSuperlayer];}
int HGMousePressed(void){return (NSEvent.pressedMouseButtons&1)!=0;}
int HGHostAt(double x,double y,uintptr_t ownWindow){
  NSWindow *own=(__bridge NSWindow *)(void *)ownWindow;
  CFArrayRef info=CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly|kCGWindowListExcludeDesktopElements,kCGNullWindowID);
  NSArray *windows=CFBridgingRelease(info);
  for(NSDictionary *w in windows){
    if([w[(id)kCGWindowNumber] integerValue]==own.windowNumber || [w[(id)kCGWindowLayer] integerValue]!=0)continue;
    CGRect bounds;CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)w[(id)kCGWindowBounds],&bounds);
    if(!CGRectContainsPoint(bounds,CGPointMake(x,y)))continue;
    pid_t pid=[w[(id)kCGWindowOwnerPID] intValue];
    NSString *bundle=[NSRunningApplication runningApplicationWithProcessIdentifier:pid].bundleIdentifier;
    return [bundle isEqualToString:@"com.openai.codex"] || [bundle isEqualToString:@"com.openai.chatgpt"];
  }
  return 0;
}
