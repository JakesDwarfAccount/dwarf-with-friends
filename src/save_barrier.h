#pragma once

namespace dwf {

// Set from DFHack's pre-save callback before DF begins serializing world memory.
void save_barrier_begin();

// Called from plugin_onupdate on DF's core thread. Clears only after DF's save request and
// save viewscreen have both disappeared for several completed update frames.
void save_barrier_update();

// Safe from HTTP/Lua worker threads.
bool save_barrier_active();

// Lifecycle reset for a newly loaded/unloaded world.
void save_barrier_reset();

} // namespace dwf
