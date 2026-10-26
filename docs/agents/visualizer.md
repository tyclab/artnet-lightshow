# Visualizer troubleshooting

The external visualizer consumes its player's queue buffers. Audio routed around
that queue can play without animating the canvas. Verify the current renderer
version and playback path before diagnosing the lighting/capture pipeline.
A hidden or covered browser window can stop painting; use a foreground capture
window when testing. Keep source-application names and private deployment details
out of this public repository.
