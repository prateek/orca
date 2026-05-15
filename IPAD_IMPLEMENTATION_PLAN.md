# iPad Layout Support - Better UX Implementation Plan

## Context

The Orca mobile app currently targets iPhone only (`supportsTablet: false`) with portrait-only orientation. iPad support was intentionally dropped before App Store submission to avoid screenshot requirements. However, the app's architecture is already responsive-friendly (uses flexbox, design tokens, `useSafeAreaInsets`) which makes restoring iPad support feasible.

**Why this change**: Enable iPad users to use Orca with a native tablet experience rather than a scaled-up phone interface.

**User Request**: Implement the "Better UX" version that makes Orca feel iPad-native, not just enable tablet support minimally.

## Prerequisites

### Development Environment
- Xcode 14+ with iOS 16+ SDK
- Node.js 24+ and pnpm 10.24.0+
- iPad simulators installed (iPad Mini, iPad Air, iPad Pro 11", iPad Pro 12.9")
- TestFlight account configured for beta distribution

### Required Knowledge
- React Native fundamentals (hooks, StyleSheet API, Platform API)
- Expo Router file-based routing
- React Native's `useWindowDimensions` and `useSafeAreaInsets` hooks
- iOS development basics (orientation handling, split-view multitasking)

### Codebase Familiarity
- Review responsive patterns in `mobile/src/components/BottomDrawer.tsx`
- Understand terminal architecture in `mobile/src/terminal/TerminalWebView.tsx`
- Read design tokens in `docs/STYLEGUIDE.md`

## Glossary

- **PTY (Pseudoterminal)**: Virtual terminal interface that shells and processes attach to. Resizing PTY during active sessions can corrupt terminal apps.
- **TUI (Terminal User Interface)**: Full-screen terminal applications like vim, emacs, htop that manage their own display.
- **Alt-screen**: Alternate screen buffer used by TUI apps (allows clearing screen without losing scrollback history).
- **iOS HIG**: Apple's Human Interface Guidelines - design standards for iOS/iPadOS apps.
- **ProMotion**: Apple's 120Hz display technology on iPad Pro models (requires 8.3ms frame time vs 16.6ms for 60fps).
- **RN**: React Native (the framework this mobile app uses).

## Implementation Strategy

This plan uses a **phased approach** over 6-7 weeks, with each phase shippable independently (except Phase 3 depends on 1-2). This enables continuous delivery and risk mitigation.

### Architecture Decisions

**Responsive System**: Custom approach using existing patterns
- Use `useWindowDimensions()` directly (already used in BottomDrawer.tsx for reactive layout)
- Calculate responsive values inline based on actual dimensions
- **Rationale**: Avoid abstraction overhead when inline calculations are simpler

**Device Detection**:
- iPad detection: `Platform.OS === 'ios' && minDimension >= 768`
  - Note: `Platform.isPad` does NOT exist in React Native - must use dimension-based detection
- Use actual window dimensions for layout decisions rather than device type checks

**Navigation**: Keep existing Stack-based navigation, enhance with iPad-specific patterns (popovers, sidebar toggles)

---

## Phase 1: Responsive Infrastructure (Week 1)

**Goal**: Build foundation without changing any UI. This phase is low-risk and can ship independently.

### 1.1 Create Responsive System

**New File**: `mobile/src/responsive/device-detection.ts`
```typescript
// isIPadDevice() - Returns true for iPad devices (see Device Detection above)
// Uses screen dimension heuristic since Platform.isPad doesn't exist
```

**New File**: `mobile/src/responsive/layout-constants.ts`
```typescript
// iPad-specific spacing, max content widths
// Example: MAX_CONTENT_WIDTH_TABLET = 700
// Avoid hardcoded breakpoint values - use in combination with useWindowDimensions
```

### 1.2 Update Configuration

**File**: `mobile/app.json`
- Change `"supportsTablet": false` → `true` (line 17)
- Change `"orientation": "portrait"` → `"default"` (line 6)
- Allows all orientations (portrait, landscape, landscape-left, landscape-right)

### 1.3 Extend Theme System

**File**: `mobile/src/theme/mobile-theme.ts`
- Add responsive spacing values: `spacingTablet = { sm: 12, md: 16, lg: 24, xl: 32 }`
- Add grid layout constants: `gridColumns = { phone: 1, tabletPortrait: 2, tabletLandscape: 3 }`
- Keep existing phone values as defaults

**Verification**: Run `pnpm typecheck` in mobile/, confirm no errors. Test app still runs on iPhone simulator.

---

## Phase 2: Screen-by-Screen Adaptive Layouts (Weeks 2-3)

**Goal**: Make each screen responsive. Start with low-risk screens (home, host list), then tackle complex session screen.

### 2.1 Home Screen - Enhanced Single-Column Layout

**File**: `mobile/app/index.tsx` (lines 928-1300 contain styles)

**Changes**:
1. Keep single-column FlatList (multi-column causes poor scannability for rich metadata cards)
2. Use `useWindowDimensions()` to calculate max content width:
   - Phone: full width with padding
   - iPad: max 700px centered with generous side padding
3. Increase touch target sizes on iPad (36pt → 44pt minimum)
4. Scale spacing based on available width (more breathing room on iPad)
5. Larger typography on iPad for better readability

**Why single-column**: Worktree cards contain dense metadata (repo, branch, status, terminal count). Multi-column forces truncation and smaller touch targets. Better to use extra space for larger type and spacing.

**Expected Result**: 
- iPhone: Current layout
- iPad: Centered 700px column with enhanced spacing and larger touch targets
- Multi-column grid deferred to Phase 7+ as experimental feature (requires user testing)

### 2.2 Host Detail Screen - Enhanced List Layout

**File**: `mobile/app/h/[hostId]/index.tsx`

**Changes**:
1. Wrap content in max-width container (800px) centered on iPad
2. Add responsive padding based on breakpoint
3. Scale up typography on iPad (use responsive type scale)
4. Keep single-column list (worktrees are complex, don't need multi-column)

**Expected Result**: Better use of iPad screen real estate without overwhelming UX.

### 2.3 Terminal Session Screen - Enhanced Tab Bar (NOT Split View)

**Current Structure** (`mobile/app/h/[hostId]/session/[worktreeId].tsx`, ~3150 lines):
- sessionChrome (header + horizontal tab bar)
- terminalFrame (flex: 1) with TerminalPaneView[] (absolute positioned, one per terminal)
- commandDock (keyboard accessory + input bar)
- Multiple modals (ActionSheetModal, TextInputModal, etc.)

**iPad Enhancement Strategy**:
```
┌──────────────────────────────────────────┐
│  Chrome Header (back, title, status)     │
│  Tab Bar (larger targets, swipe gestures)│
├──────────────────────────────────────────┤
│                                          │
│         Terminal Panes (flex: 1)         │
│                                          │
│         [TerminalWebView]                │
│                                          │
│                                          │
├──────────────────────────────────────────┤
│  Command Dock (input + accessories)      │
└──────────────────────────────────────────┘
```

**Why NOT split-view with file tree**:
- Users rarely need simultaneous file-tree + terminal (based on UX review feedback)
- File browser already accessible via dedicated Files screen/button
- 280-320px sidebar wastes horizontal space needed for comfortable terminal work
- Users actually want: better tab switching and dual-terminal support (deferred to Phase 7+)

**Implementation**:

**Changes to** `mobile/app/h/[hostId]/session/[worktreeId].tsx`:
1. Scale up tab bar on iPad:
   - Increase tab height: 44pt → 60pt on iPad
   - Larger touch targets for tab buttons
   - Show more visible tabs before scrolling (wider screen)
2. Add swipe gestures between tabs (left/right swipe on terminal area)
3. Add tab long-press menu for quick actions (rename, close, pin)
4. Keep existing single-terminal layout (dual-terminal split deferred to Phase 7+)

**Key Technical Considerations**:
- **⚠️ CRITICAL**: Never resize PTY on rotation/layout changes - only adjust CSS scale (see Phase 4.1 for details)
- Keyboard avoidance: Keep existing `transform: translateY` pattern
- Tab switching: Keep existing unsubscribe/resubscribe pattern

**Expected Result**: 
- iPhone: Current layout
- iPad: Enhanced tab bar with larger touch targets, swipe navigation
- File browser stays as separate dedicated screen (navigate via Files button)

### 2.4 File Browser - Enhanced Full-Screen Mode

**File**: `mobile/app/h/[hostId]/files/[worktreeId].tsx`

**Changes**:
1. Keep as dedicated full-screen experience (no sidebar embedding)
2. On iPad: Use max-width container (800px) with better spacing
3. Larger touch targets for folders and files (44pt minimum)
4. Optional: Add breadcrumb trail at top for easier navigation
5. Maintain FlatList virtualization for performance with large repos

**Expected Result**: File browser remains a focused, dedicated screen optimized for iPad.

---

## Phase 3: iPad-Specific UI Patterns (Week 4)

**Goal**: Polish interactions and gestures for iPad.

### 3.1 Adaptive Modals

**New Component**: `mobile/src/components/AdaptiveActionSheet.tsx`
- Phone: BottomDrawer (existing)
- iPad: Centered modal sheet with backdrop
- Automatically selects based on device type

**Files to Update**:
- Replace `<ActionSheetModal>` usage with `<AdaptiveActionSheet>` in session screen, home screen
- Replace `<BottomDrawer>` with adaptive variant where appropriate

### 3.2 Keyboard Shortcuts (External Keyboard Support)

Add comprehensive keyboard event listeners for external keyboards:
- **Tab Management**: Cmd+T (new terminal), Cmd+W (close tab), Cmd+[1-9] (switch to tab N)
- **Navigation**: Cmd+K (quick switcher/command palette), Cmd+L (focus input), Tab/Shift+Tab (navigate cards)
- **Terminal**: Cmd+Shift+C/V (copy/paste in terminal context)
- **Help**: Cmd+? (show keyboard shortcuts modal)

**File**: `mobile/app/h/[hostId]/session/[worktreeId].tsx`
- Add keyboard event listeners in `useEffect` with focus-aware logic
- Only enable shortcuts when terminal WebView is NOT focused (avoid conflicts with vim, emacs)
- Use `onKeyDown` on outer container with conditional `stopPropagation()`
- Test: Ensure Cmd+W in vim doesn't close the tab (terminal should capture it)

### 3.3 Typography & Touch Target Scaling

**File**: `mobile/src/theme/mobile-theme.ts`
- Add responsive typography scale
- Increase minimum touch targets from 36pt to 44pt on iPad
- Apply via responsive utilities

---

## Phase 4: Terminal WebView Optimizations (Week 5)

**Goal**: Optimize terminal rendering for larger iPad screens.

### 4.1 Terminal Rendering Enhancements

**File**: `mobile/src/terminal/TerminalWebView.tsx`

**Changes**:
1. Increase default font size on iPad: 14pt → 16pt
   - Only apply if user hasn't customized terminal font (check AsyncStorage `terminal.fontSize` key)
2. **⚠️ CRITICAL - PTY Resize Constraint**:
   - Never resize PTY on orientation/layout changes - only adjust CSS `transform: scale()`
   - Why: Resizing interrupts TUI apps (vim, emacs, Claude Code) and corrupts alt-screen buffer
   - Use existing `computeFitScale()` logic to fit desktop PTY dimensions into mobile viewport
3. Add optional pinch-to-zoom for accessibility (defer if problematic - use system zoom instead)
4. Optimize keyboard handling: Pass through more key combos when WebView focused

**Acceptance Criteria**:
- Terminal remains usable during rotation without screen corruption
- Font size respects user's custom setting if configured
- No PTY resize messages sent to desktop during layout changes

### 4.2 Split-Screen Multitasking Support

**iOS/iPadOS Split View Testing**:
- Listen to window dimension changes (`useWindowDimensions` already does this)
- Gracefully degrade layout when app width < 480px (e.g., iPad in 1/3 split)
  - Switch to compact phone-style layout
  - Reduce tab bar height, use smaller touch targets
- Debounce dimension changes with 150-200ms delay to avoid layout thrash during drag
- Test all split positions: 1/4, 1/3, 1/2, 2/3, 3/4, full screen

**All Screens**:
- Add dimension change debouncing to prevent constant re-renders during split-screen resize
- Use `useMemo` to only trigger layout changes when width crosses thresholds, not on every pixel change

---

## Phase 5: Testing & Polish (Week 6)

**Goal**: Comprehensive testing across devices and orientations.

### 5.1 Device Testing Matrix

Test on simulators:
- iPad Mini (8.3") - portrait & landscape
- iPad Air (10.9") - portrait & landscape  
- iPad Pro 11" - portrait & landscape
- iPad Pro 12.9" - portrait & landscape
- iPad Pro with external keyboard (shortcuts)
- iPad in Split View (1/3, 1/2, 2/3 screen widths)

### 5.2 Orientation Handling

**All Screens**:
- Add orientation change listeners
- Test smooth transitions between portrait ↔ landscape
- Preserve scroll position and terminal state during rotation
- Test rotation during active terminal session (no disconnects)

### 5.3 Accessibility

- VoiceOver navigation through split-view layouts
- Dynamic Type support (respect system font size preferences)
- Increased contrast mode
- Keyboard navigation for all interactive elements (tab order, focus management)

### 5.4 Performance Profiling

- Profile FlatList rendering with multi-column grids (should maintain 60fps)
- Monitor terminal rendering at larger viewport sizes
- Test memory usage with multiple terminals open
- Ensure smooth 120Hz scrolling on iPad Pro (ProMotion)

**Tool**: Use React DevTools Profiler to identify slow components

---

## Phase 6: Rollout Strategy (Week 7)

### 6.1 Optional: Compact Mode Toggle (Simplified)

**Update**: `mobile/app/settings.tsx`
- Add "Use Compact Layout" toggle in settings
- **Default: OFF** (iPad users get iPad layout automatically)
- When enabled: Forces phone-style layout even on iPad
- Use case: Users who prefer smaller UI or have accessibility preferences

**No Complex Feature Flag System**:
- Ship iPad support enabled by default for iPad devices
- Use simple boolean toggle for users who want compact mode
- Avoid AsyncStorage-backed feature flag infrastructure (unnecessary complexity)

### 6.2 Phased Rollout

1. Week 1-3: Internal alpha testing (dev builds only)
2. Week 4-5: TestFlight beta to 50-100 users (iPad layout ON by default)
3. Week 6: Collect feedback, fix critical bugs
4. Week 7: Production release (iPad layout ON by default for iPad users)
   - Include "Use Compact Layout" toggle for users who prefer phone UI
   - Monitor crash rates, performance metrics, user feedback

### 6.3 Monitoring & Success Metrics

**Track**:
- Layout preference: % of iPad users who enable "Use Compact Layout" toggle (expect <20%)
- Engagement: Session duration on iPad vs iPhone (expect increase)
- Performance: 60fps maintained during scrolling, terminal rendering
- Stability: Crash rate on iPad ≤ crash rate on iPhone
- User feedback: Net Promoter Score (NPS) from iPad users

**Alert Thresholds**:
- Crash rate > 2% → investigate immediately
- FPS drops below 50 → performance regression
- Feature flag disable rate > 20% → UX issues

---

## Risk Mitigation

### High-Risk Areas

**1. Terminal Session Screen Complexity** (~3150 lines)
- **Risk**: Breaking existing terminal functionality during tab bar enhancements
- **Mitigation**: 
  - Keep changes minimal (touch targets, swipe gestures only)
  - Test thoroughly with active terminal sessions before/after changes
  - Avoid restructuring the complex 3150-line component
- **Fallback**: Settings toggle allows users to switch to compact mode

**2. Keyboard Handling**
- **Risk**: External keyboard shortcuts conflict with terminal input (vim, emacs need all keys)
- **Mitigation**: Focus-aware logic only enables shortcuts when terminal WebView NOT focused
- **Testing**: Open vim, press Cmd+W - should delete word in vim, not close tab

**3. Performance on Older iPads**
- **Risk**: Enhanced layouts or gesture handling degrade scrolling on A12 chips
- **Mitigation**: Profile early on oldest supported device (iPad 7th gen / 2019)
- **Testing**: Maintain 60fps during FlatList scroll, tab switching, rotation

### Fallback Strategy

If critical issues found after release:
- Settings toggle allows users to switch to "Use Compact Layout" (stored in AsyncStorage)
- Users experiencing issues can manually revert to phone-style UI
- Ship App Store hotfix to change default behavior for new installs if needed
- No data loss or session interruption when switching layouts

---

## Critical Files

**New Files**:
- `mobile/src/responsive/device-detection.ts` - iPad device detection utilities
- `mobile/src/responsive/layout-constants.ts` - Max widths, spacing values for iPad
- `mobile/src/components/AdaptiveActionSheet.tsx` - Platform-adaptive modals

**Modified Files**:
- `mobile/app.json` - Enable tablet support, allow all orientations
- `mobile/src/theme/mobile-theme.ts` - Add responsive spacing/typography
- `mobile/app/index.tsx` - Enhanced single-column layout for iPad
- `mobile/app/h/[hostId]/index.tsx` - Max-width container for iPad
- `mobile/app/h/[hostId]/session/[worktreeId].tsx` - Enhanced tab bar (larger touch targets, swipe gestures)
- `mobile/app/h/[hostId]/files/[worktreeId].tsx` - Enhanced full-screen layout
- `mobile/src/terminal/TerminalWebView.tsx` - iPad font size, PTY constraints
- `mobile/app/settings.tsx` - "Use Compact Layout" toggle

**Files Removed from Original Plan** (deferred to post-launch):
- `mobile/src/responsive/breakpoints.ts` - Using inline calculations instead
- `mobile/src/components/SessionSplitView.tsx` - Not in initial release
- `mobile/src/feature-flags/ipad-layout.ts` - Using simple settings toggle

---

## Verification Plan

### After Phase 1 (Infrastructure)
```bash
cd mobile
pnpm typecheck  # Should pass
pnpm lint       # Should pass
pnpm start      # App runs on iPhone simulator, no visual changes
```

### After Phase 2 (Layouts)
- Launch on iPad simulator (Xcode > Open Developer Tool > Simulator > iPad Air)
- Rotate device: portrait → landscape → portrait
- Verify:
  - Home screen shows centered single-column layout (700px max-width)
  - Host detail screen uses max-width container (800px)
  - Terminal session shows enhanced tab bar (60pt height, larger touch targets)
  - File browser shows enhanced full-screen layout

### After Phase 3 (iPad Patterns)
- Test with external keyboard:
  - Cmd+T creates new terminal
  - Cmd+W closes tab
  - Cmd+1-9 switches tabs
- Action sheets appear centered (not bottom drawer) on iPad

### After Phase 4 (Terminal Optimizations)
- Test iPad in Split View (side-by-side with Safari):
  - Drag split divider: app layout adapts smoothly
  - At 1/3 width (< 480px): switches to compact phone-style layout
  - Terminal remains responsive at all widths

### After Phase 5 (Testing)
- Run on all iPad simulators in matrix
- Enable VoiceOver: navigate through enhanced layouts with gestures
- Enable Dynamic Type: increase font size to maximum, UI still usable
- Profile with React DevTools: no components take >16ms to render

### End-to-End Test Scenarios

**Scenario 1: iPad User First Launch**
1. Pair with desktop Orca
2. View worktrees in enhanced single-column layout (centered, larger touch targets)
3. Open terminal session → see enhanced tab bar with larger targets
4. Rotate to portrait → layout adapts smoothly
5. No crashes, smooth transitions

**Scenario 2: External Keyboard User**
1. Connect iPad Magic Keyboard
2. Use Cmd+T to create terminals
3. Switch tabs with Cmd+1-9
4. All shortcuts work, no conflicts with terminal input

**Scenario 3: Split View Multitasking**
1. Open Orca in full screen on iPad
2. Drag Safari to right side (50/50 split)
3. Orca layout adapts, maintains usability
4. Drag split to 1/3 Orca / 2/3 Safari (app width < 480px)
5. Orca switches to compact phone-style layout automatically
6. Drag back to 50/50: iPad layout restores

---

## Timeline Summary

- **Week 1**: Phase 1 - Infrastructure (low risk, can ship independently)
- **Week 2-3**: Phase 2 - Screen layouts (medium risk, incrementally shippable)
- **Week 4**: Phase 3 - iPad patterns (low risk, polish)
- **Week 5**: Phase 4 - Terminal optimizations (medium risk)
- **Week 6**: Phase 5 - Testing & polish (QA intensive)
- **Week 7**: Phase 6 - Rollout & monitoring (production release)

**Total**: 6-7 weeks for complete implementation

---

## Recommended Execution Order

1. **Start Here**: Phase 1 (responsive infrastructure) - foundational, low risk
2. **Quick Win**: Home screen enhanced layout (Phase 2.1) - immediate visual impact with minimal complexity
3. **Focus Energy**: Terminal session enhancements (Phase 2.3) - improved tab bar and gestures
4. **Test Early**: Set up iPad simulators and TestFlight beta from Week 1

**Incremental Shipping**:
- Phase 1 can ship alone (no UI changes, just infrastructure)
- Phase 2.1-2.2 can ship without 2.3 (home/host screens independent)
- Phase 2.3 can ship independently (terminal enhancements)
- Phase 3-5 can be shipped incrementally as enhancements

This phased approach enables continuous delivery while managing risk. Each phase provides user value independently, avoiding the "big bang" release anti-pattern.

---

## Future Work (Post-Launch)

Features deferred beyond this 6-7 week implementation:

**Multi-Column Home Grid**: Requires user testing to validate whether 2-3 column layout improves or harms scannability of dense metadata cards. Timeline: Evaluate after collecting 4-6 weeks of iPad usage data.

**File Tree Sidebar**: Needs UX research to determine if users actually want simultaneous file-tree + terminal view. Current assumption (based on expert review) is that dedicated file browser screen is sufficient. Timeline: Collect user feedback before committing to implementation.

**Dual-Terminal Split View**: Allow showing 2 terminals side-by-side on iPad landscape. High user value but technically complex (PTY state synchronization, keyboard input routing). Timeline: Separate project after initial iPad layout stabilizes.

**Table View for Worktrees**: Power-user option showing repo/branch/status/terminals as sortable table columns instead of cards. Timeline: Based on user requests.

---

## Design Decisions & Revision History

This plan was reviewed by React Native and UX experts and revised to address critical issues:

### Critical Changes Made

1. **Removed Multi-Column Home Grid** (was Phase 2.1)
   - Original: 2-3 column FlatList grid
   - Revised: Enhanced single-column with centered max-width (700px)
   - Reason: Multi-column reduces scannability of dense metadata cards; FlatList `numColumns` requires jarring remount on rotation

2. **Replaced Split-View Terminal Design** (was Phase 2.3)
   - Original: File tree sidebar + terminal (280-320px sidebar)
   - Revised: Enhanced tab bar with larger touch targets and swipe gestures
   - Reason: Users rarely need simultaneous file-tree + terminal; they want better tab switching and dual-terminal support (deferred to future)

3. **Fixed Platform.isPad Detection**
   - Original: Used `Platform.isPad` (doesn't exist in React Native)
   - Revised: `Platform.OS === 'ios' && minDimension >= 768`
   - Impact: All device detection code

4. **Terminal PTY Resize Prevention**
   - Original: Resize PTY when layout changes
   - Revised: Only adjust CSS scale, never resize PTY on layout change
   - Reason: Resizing interrupts TUI apps (vim, Claude Code) and can corrupt alt-screen rendering

5. **Removed Complex Feature Flag System** (was Phase 6.1)
   - Original: AsyncStorage-backed enable/disable/check functions, default OFF
   - Revised: Simple "Use Compact Layout" toggle, iPad layout ON by default
   - Reason: Feature flags add complexity; users expect iPad layout automatically

6. **Keyboard Shortcuts Expansion** (Phase 3.2)
   - Original: Only tab management (Cmd+T, Cmd+W, Cmd+1-9)
   - Revised: Added Cmd+K palette, Cmd+L focus, Cmd+? help, focus-aware logic
   - Reason: Comprehensive keyboard support essential for iPad users; avoid conflicts with terminal input

7. **Split-Screen Threshold Adjustment** (Phase 4.2)
   - Original: Collapse at < 600px
   - Revised: Collapse at < 480px
   - Reason: 600px triggers collapse on iPad Mini portrait (744px) - too aggressive

### Technical Corrections

- Clarified no Expo Router SplitView component exists (custom implementation)
- Retained manual keyboard avoidance pattern (proven to work)
- Added debouncing for dimension changes during split-screen drag
- Specified typography scaling respects user settings
- Maintained FlatList virtualization for file browser

### Files Modified in Revision

**New Files** (updated approach):
- `mobile/src/responsive/device-detection.ts` (not breakpoints.ts)
- `mobile/src/responsive/layout-constants.ts` (simplified)

**Modified Files** (updated scope):
- `mobile/app/index.tsx` - Enhanced single-column, not multi-column grid
- `mobile/app/h/[hostId]/session/[worktreeId].tsx` - Tab bar enhancements, not split-view
- `mobile/app/h/[hostId]/files/[worktreeId].tsx` - Enhanced full-screen, not sidebar mode
- `mobile/app/settings.tsx` - Simple compact toggle, not feature flag system

**Removed/Deferred**:
- `mobile/src/components/SessionSplitView.tsx` - Not needed in initial release
- Multi-column grid logic - Deferred to Phase 7+ as experimental feature
- File tree sidebar embedding - Deferred to Phase 7+
- Dual-terminal split - Deferred to Phase 7+ (high user value, but complex)

### Overall Impact

**Reduced Complexity**: Simplified approach reduces implementation time by ~30% while delivering better UX
**Improved UX**: Focus on proven patterns (enhanced single-column, better tab bar) over experimental split-views
**Lower Risk**: Fewer layout remounts, no PTY resizing, simpler rollout strategy
**Better Alignment**: Matches React Native best practices and iOS HIG guidelines

The revised plan is technically sound, UX-validated, and ready for implementation.
