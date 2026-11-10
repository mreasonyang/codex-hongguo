package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/transfer"
	"github.com/egoist/mygo/ui"
)

type Snapshot struct {
	SeriesID  string  `json:"seriesId"`
	EpisodeID string  `json:"episodeId"`
	Title     string  `json:"title"`
	Label     string  `json:"label"`
	Position  int64   `json:"positionMs"`
	Duration  int64   `json:"durationMs"`
	Paused    bool    `json:"paused"`
	Muted     bool    `json:"muted"`
	Volume    float64 `json:"volume"`
	Rate      float64 `json:"rate"`
}
type Point struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}
type Viewport struct {
	X       float64 `json:"x"`
	Y       float64 `json:"y"`
	Width   float64 `json:"width"`
	Height  float64 `json:"height"`
	Visible bool    `json:"visible"`
}
type Preferences struct {
	Hover bool   `json:"hoverDecoyEnabled"`
	Cover string `json:"coverStyle"`
}
type Scene struct {
	ID          string      `json:"id"`
	Generation  int         `json:"generation"`
	Control     int         `json:"control"`
	Action      string      `json:"controlAction"`
	Phase       string      `json:"phase"`
	Snapshot    *Snapshot   `json:"snapshot"`
	MediaURL    string      `json:"mediaURL"`
	Locale      string      `json:"locale"`
	Error       string      `json:"error"`
	Dragging    bool        `json:"dragging"`
	Point       *Point      `json:"point"`
	Viewport    *Viewport   `json:"viewport"`
	SourceAlive bool        `json:"sourceAlive"`
	Preferences Preferences `json:"preferences"`
}
type Bootstrap struct {
	Origin string `json:"origin"`
	Key    string `json:"key"`
}
type App struct {
	boot     Bootstrap
	http     *http.Client
	players  map[string]*Player
	events   chan map[string]any
	lastGood time.Time
}
type Player struct {
	app          *App
	window       *mygo.Window
	video        uintptr
	scene        Scene
	generation   int
	control      int
	media        string
	ready        int
	frozen       int
	failed       int
	visible      bool
	covered      bool
	hovered      bool
	follow       bool
	lastPosition float64
	seek         float64
	volume       float64
	lastProgress time.Time
	moved        bool
	placing      bool
	hoverKnown   bool
	ended        bool
	dragFinished int
}

func main() {
	var boot Bootstrap
	if json.NewDecoder(io.LimitReader(os.Stdin, 4096)).Decode(&boot) != nil {
		return
	}
	_ = os.Stdin.Close()
	u, err := url.Parse(boot.Origin)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.User != nil || len(boot.Key) < 24 {
		return
	}
	app := &App{boot: boot, http: &http.Client{Timeout: 3 * time.Second}, players: map[string]*Player{}, events: make(chan map[string]any, 64), lastGood: time.Now()}
	mygo.App.SetName("红果播放器")
	mygo.App.SetActivationPolicy(mygo.ActivationPolicyAccessory)
	mygo.App.WhenReady(func() { go app.poll(); go app.sendEvents(); go app.frames() })
	_ = mygo.App.Run()
}
func (a *App) request(method, path string, body io.Reader) (*http.Response, error) {
	r, e := http.NewRequest(method, a.boot.Origin+path, body)
	if e != nil {
		return nil, e
	}
	r.Header.Set("Authorization", "Bearer "+a.boot.Key)
	if body != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	return a.http.Do(r)
}
func (a *App) sendEvents() {
	for event := range a.events {
		b, e := json.Marshal(event)
		if e != nil {
			continue
		}
		r, e := a.request("POST", "/event", bytes.NewReader(b))
		if e == nil {
			io.Copy(io.Discard, io.LimitReader(r.Body, 1024))
			r.Body.Close()
		}
	}
}
func (p *Player) event(kind string, extra map[string]any) {
	e := map[string]any{"type": kind, "playerId": p.scene.ID, "generation": p.scene.Generation, "control": p.scene.Control}
	for k, v := range extra {
		e[k] = v
	}
	select {
	case p.app.events <- e:
	default:
	}
}
func (p *Player) command(command string, extra map[string]any) {
	if extra == nil {
		extra = map[string]any{}
	}
	extra["command"] = command
	p.event("command", extra)
}
func (p *Player) snapshot() map[string]any {
	s := readVideo(p.video)
	paused := s.rate == 0
	if p.scene.Snapshot != nil && p.scene.Phase == "detaching" {
		paused = p.scene.Snapshot.Paused
	}
	return map[string]any{"positionMs": int64(math.Round(s.position * 1000)), "durationMs": int64(math.Round(s.duration * 1000)), "paused": paused, "rate": p.scene.Snapshot.Rate, "muted": s.muted, "volume": s.volume}
}
func (a *App) poll() {
	for range time.NewTicker(100 * time.Millisecond).C {
		r, err := a.request("GET", "/state", nil)
		if err != nil {
			if time.Since(a.lastGood) > 4*time.Second {
				mygo.RunOnMain(func() {
					for _, p := range a.players {
						if p.visible {
							p.scene.Snapshot.Paused = true
							applyVideo(p.video, *p.scene.Snapshot, false)
							p.scene.Error = "连接已中断，已暂停并保留进度"
							p.window.Invalidate()
						}
					}
				})
			}
			if time.Since(a.lastGood) > time.Minute {
				mygo.RunOnMain(func() { mygo.App.Quit() })
				return
			}
			continue
		}
		var result struct {
			Players []Scene `json:"players"`
		}
		err = json.NewDecoder(io.LimitReader(r.Body, 2<<20)).Decode(&result)
		r.Body.Close()
		if err != nil || r.StatusCode != 200 {
			continue
		}
		a.lastGood = time.Now()
		mygo.RunOnMain(func() {
			for _, s := range result.Players {
				p := a.players[s.ID]
				if p == nil {
					p = &Player{app: a, generation: -1, control: -1, ready: -1, frozen: -1, failed: -1}
					a.players[s.ID] = p
					p.create()
				}
				p.apply(s)
			}
		})
	}
}
func (p *Player) create() {
	p.window = mygo.NewWindow(mygo.WindowOptions{Title: "红果短剧", Width: 480, Height: 420, MinWidth: 320, MinHeight: 280, Hidden: true, Content: ui.View(p.view)})
	p.video = createVideo(p.window.NativeHandle())
	p.window.SetAlwaysOnTop(true)
	p.window.OnClose(func(e *mygo.CloseEvent) { e.PreventDefault(); p.command("dock", nil) })
	p.window.OnMove(func() {
		if !p.follow && !p.placing && p.visible {
			p.moved = true
		}
	})
}
func (p *Player) apply(s Scene) {
	old := p.scene
	p.scene = s
	if s.Phase == "docked" || s.Snapshot == nil {
		p.window.SetIgnoreMouseEvents(false)
		if p.visible {
			p.window.Hide()
			p.visible = false
			loadVideo(p.video, "")
		}
		return
	}
	if s.Phase == "docking" {
		p.window.SetIgnoreMouseEvents(false)
		if p.frozen != s.Generation {
			snap := p.snapshot()
			if p.media == "" || p.media != s.MediaURL || p.ready < 0 {
				snap = map[string]any{"positionMs": s.Snapshot.Position, "durationMs": s.Snapshot.Duration, "paused": s.Snapshot.Paused, "muted": s.Snapshot.Muted, "volume": s.Snapshot.Volume, "rate": s.Snapshot.Rate}
			}
			freeze := *s.Snapshot
			freeze.Paused = true
			applyVideo(p.video, freeze, false)
			p.frozen = s.Generation
			p.event("frozen", snap)
		}
		return
	}
	if s.MediaURL == "" {
		freeze := *s.Snapshot
		freeze.Paused = true
		applyVideo(p.video, freeze, false)
		p.window.Invalidate()
		return
	}
	generationChanged := p.generation != s.Generation
	if generationChanged || p.media != s.MediaURL {
		p.generation = s.Generation
		p.control = -1
		p.ready = -1
		p.media = s.MediaURL
		p.covered = false
		p.hoverKnown = false
		p.ended = false
		loadVideo(p.video, s.MediaURL)
		initial := *s.Snapshot
		if s.Preferences.Hover && !p.hovered {
			initial.Paused = true
			p.covered = true
		}
		applyVideo(p.video, initial, true)
		if !p.visible {
			p.place(s.Point)
			p.window.ShowInactive()
			p.visible = true
		}
		p.follow = s.Dragging && mousePressed()
	}
	if p.control != s.Control {
		requested := *s.Snapshot
		if s.Preferences.Hover && p.covered {
			requested.Paused = true
		}
		applyVideo(p.video, requested, s.Action == "seek")
		p.control = s.Control
	}
	if s.Dragging && !mousePressed() && p.dragFinished != s.Generation {
		p.dragFinished = s.Generation
		p.event("drag-end", nil)
	}
	if old.Snapshot != nil && !s.Dragging && old.Dragging {
		p.follow = false
		p.window.SetIgnoreMouseEvents(false)
	}
	if !p.follow && !generationChanged && p.moved && !mousePressed() {
		p.moved = false
		p.checkDrop(true)
	}
	if p.covered != s.Preferences.Hover && !s.Preferences.Hover {
		p.covered = false
		hideVideo(p.video, false)
	}
	p.window.SetIgnoreMouseEvents(p.follow && mousePressed())
	p.window.Invalidate()
}
func oldPosition(s Scene) int64 {
	if s.Snapshot == nil {
		return -1
	}
	return s.Snapshot.Position
}
func (p *Player) place(point *Point) {
	p.placing = true
	defer func() { p.placing = false }()
	q := mygo.Screen.CursorScreenPoint()
	if point != nil {
		q.X = int(point.X)
		q.Y = int(point.Y)
	}
	p.window.SetPosition(q.X-180, q.Y-28)
}
func (a *App) frames() {
	for range time.NewTicker(time.Second / 30).C {
		mygo.RunOnMain(func() {
			for _, p := range a.players {
				if !p.visible || p.scene.Snapshot == nil || p.scene.Phase == "docked" {
					continue
				}
				if p.follow {
					if mousePressed() {
						q := mygo.Screen.CursorScreenPoint()
						p.window.SetIgnoreMouseEvents(true)
						p.window.SetPosition(q.X-180, q.Y-28)
					} else {
						p.follow = false
						p.window.SetIgnoreMouseEvents(false)
						p.event("drag-end", nil)
					}
				}
				s := readVideo(p.video)
				if s.failed && p.failed != p.scene.Generation {
					p.failed = p.scene.Generation
					p.event("error", nil)
				}
				if s.ready && p.scene.Phase == "detaching" && p.media == p.scene.MediaURL && p.scene.MediaURL != "" && p.generation == p.scene.Generation && p.ready != p.scene.Generation {
					p.ready = p.scene.Generation
					p.event("ready", p.snapshot())
				}
				if p.scene.Phase == "detached" && time.Since(p.lastProgress) > 250*time.Millisecond {
					p.event("progress", p.snapshot())
					p.lastProgress = time.Now()
				}
				if p.scene.Phase == "detached" && s.duration > 0 && s.position >= s.duration-0.08 && !p.ended {
					p.ended = true
					p.command("ended", nil)
				}
				if s.position != p.lastPosition {
					p.lastPosition = s.position
					p.window.Invalidate()
				}
			}
		})
	}
}
func (p *Player) checkDrop(moved bool) {
	// Standard title-bar moves can return too; check only after the physical mouse release.
	if mousePressed() || p.scene.Phase != "detached" || p.scene.Viewport == nil || !p.scene.SourceAlive {
		return
	}
	if !moved {
		return
	}
	v := p.scene.Viewport
	q := mygo.Screen.CursorScreenPoint()
	b := p.window.Bounds()
	if v.Visible && float64(q.X) >= v.X && float64(q.X) <= v.X+v.Width && float64(q.Y) >= v.Y && float64(q.Y) <= v.Y+v.Height &&
		q.X >= b.X && q.X <= b.X+b.Width && q.Y >= b.Y && q.Y <= b.Y+50 && hostAt(q.X, q.Y, p.window.NativeHandle()) {
		p.event("drag-end", map[string]any{"point": Point{float64(q.X), float64(q.Y)}})
	}
}
func (p *Player) tr(zh, en string) string {
	if strings.HasPrefix(strings.ToLower(p.scene.Locale), "en") {
		return en
	}
	return zh
}
func clock(ms int64) string { sec := ms / 1000; return fmt.Sprintf("%d:%02d", sec/60, sec%60) }
func (p *Player) view(c *ui.Context) {
	if p.scene.Snapshot == nil {
		return
	}
	s := p.scene.Snapshot
	t := c.Theme()
	width, height := c.Size()
	root := ui.Column(c).Fill().Background(t.Background).Gap(0)
	hovered := root.Hovered()
	if (!p.hoverKnown || hovered != p.hovered) && !p.follow && p.scene.Phase == "detached" {
		p.hoverKnown = true
		p.hovered = hovered
		if p.scene.Preferences.Hover {
			p.covered = !hovered
			hideVideo(p.video, p.covered)
			if hovered {
				p.command("hover-enter", nil)
			} else {
				p.command("hover-leave", map[string]any{"paused": s.Paused})
			}
		}
	}
	root.Children(func() {
		ui.Row(c).Height(48).WidthPercent(100).Padding(12).Gap(10).AlignItems(ui.Center).Children(func() {
			title := p.tr("拖回侧栏", "Drag back to sidebar")
			if !p.covered {
				title = s.Title
			}
			ui.Box(c).Grow(1).Height(40).DragData(transfer.TextData("hongguo-player:"+p.scene.ID), transfer.DragOptions{
				Operations: transfer.Move, Hotspot: image.Point{X: 40, Y: 20}, Done: func(r transfer.Result) {
					overHost := hostAt(r.Point.X, r.Point.Y, p.window.NativeHandle())
					p.event("drag-end", map[string]any{"point": Point{float64(r.Point.X), float64(r.Point.Y)}, "canceled": r.Canceled, "escaped": r.Escaped, "overHost": overHost})
					if !r.Escaped && r.Canceled && !overHost {
						p.place(&Point{float64(r.Point.X), float64(r.Point.Y)})
					}
				},
			}).Children(func() {
				ui.Column(c).Gap(2).Children(func() {
					ui.Text(c, title).Ellipsis("…").Bold()
					if !p.covered {
						ui.Text(c, s.Label).FontSize(11)
					}
				})
			})
			if ui.Button(c, p.tr("返回面板", "Return")).Clicked() {
				p.command("dock", nil)
			}
		})
		videoHeight := max(float32(80), height-196)
		if p.covered {
			videoHeight = height - 48
		}
		ui.Box(c).WidthPercent(100).Height(videoHeight).Background(ui.Hex("#090a0d")).Center().Children(func() {
			if p.covered {
				ui.Column(c).Gap(16).Padding(24).Children(func() {
					ui.Text(c, p.tr("项目工作区", "Project workspace")).FontSize(22).Bold()
					ui.Text(c, p.tr("需求整理  ·  进行中\n接口联调  ·  待处理\n回归验证  ·  已完成", "Requirements · In progress\nIntegration · Pending\nVerification · Complete")).Wrap()
				})
			}
		})
		frameVideo(p.video, 0, 48, width, videoHeight)
		hideVideo(p.video, p.covered)
		if p.covered {
			return
		}
		ui.Column(c).WidthPercent(100).Padding(12).Gap(8).Children(func() {
			status := readVideo(p.video)
			p.seek = status.position
			if ui.Slider(c, &p.seek, 0, max(1, status.duration)).WidthPercent(100).Changed() {
				p.command("seek", map[string]any{"positionMs": int64(p.seek * 1000)})
			}
			ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
				if ui.Button(c, "‹").Label(p.tr("上一集", "Previous")).Clicked() {
					p.command("previous", nil)
				}
				toggle := p.tr("暂停", "Pause")
				if status.rate == 0 {
					toggle = p.tr("播放", "Play")
				}
				if ui.Button(c, toggle).Clicked() {
					p.command("toggle", map[string]any{"paused": status.rate != 0})
				}
				if ui.Button(c, "›").Label(p.tr("下一集", "Next")).Clicked() {
					p.command("next", nil)
				}
				ui.Text(c, clock(int64(status.position*1000))+" / "+clock(int64(status.duration*1000))).Grow(1).FontSize(12)
				mute := p.tr("静音", "Mute")
				if status.muted {
					mute = p.tr("取消静音", "Unmute")
				}
				if ui.Button(c, mute).Clicked() {
					p.command("mute", map[string]any{"muted": !status.muted})
				}
				if ui.Button(c, fmt.Sprintf("%g×", s.Rate)).Label(p.tr("播放速度", "Playback speed")).Clicked() {
					rates := []float64{0.75, 1, 1.25, 1.5, 2}
					next := rates[0]
					for i, r := range rates {
						if r == s.Rate {
							next = rates[(i+1)%len(rates)]
							break
						}
					}
					p.command("rate", map[string]any{"rate": next})
				}
			})
			ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
				ui.Text(c, p.tr("音量", "Volume")).FontSize(12)
				p.volume = s.Volume
				if ui.Slider(c, &p.volume, 0, 1).Grow(1).Changed() {
					p.command("volume", map[string]any{"volume": p.volume})
				}
			})
			if p.scene.Error != "" {
				ui.Text(c, p.scene.Error).FontSize(12).Wrap()
			}
		})
	})
}
