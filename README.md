# DMX Monitor

A Node.js console application for monitoring, recording, and playing back sACN (E1.31) and Art-Net DMX traffic in real-time.

## Features

- **Protocol Support**: Monitor both sACN (E1.31) and Art-Net protocols
- **Interactive Setup**: Guided configuration with sensible defaults
- **Network Interface Selection**: Choose specific interfaces or bind to all
- **Multicast/Broadcast Support**: Proper handling for both protocols
- **Universe Detection**: Automatically discovers active universes
- **Real-time Display**: 32x16 grid showing all 512 DMX channels
- **Color-coded Values**: Visual representation (red=0, green=255)
- **Live Statistics**: Packet rate, error count, uptime
- **Recording**: Record DMX data to `.dmxrec` files for later playback
- **Playback**: Play back recorded DMX data with speed control, looping, and seeking
- **TypeScript**: Fully typed for safety and maintainability
- **Comprehensive Error Handling**: Graceful handling of network and protocol errors

## Installation

### Prebuilt Binaries (Recommended)

Prebuilt standalone executables are available for Windows, macOS, and Linux on the [Releases page](https://github.com/nova3uk/DMX-Monitor/releases). These binaries include Node.js bundled inside, so **Node.js does NOT need to be installed** on your system.

1. Go to the [latest release](https://github.com/nova3uk/DMX-Monitor/releases/latest)
2. Download the binary for your platform:
   - **Windows**: `dmx-monitor-v*-win-x64.exe`
   - **macOS**: `dmx-monitor-v*-macos-x64`
   - **Linux**: `dmx-monitor-v*-linux-x64`
3. Make the file executable (macOS/Linux): `chmod +x dmx-monitor-v*-macos-x64` or `chmod +x dmx-monitor-v*-linux-x64`
4. Run it directly!

### From Source

If you prefer to build from source or need to modify the code:

```bash
# Clone or download the project
cd dmx-monitor

# Install dependencies
npm install

# Build TypeScript
npm run build
```

## Usage

### Interactive Mode

Simply run without arguments for guided setup:

```bash
npm start
```

Or after building:

```bash
node dist/index.js
```

### Command Line Options

```bash
dmx-monitor [options]

Options:
  -V, --version              output the version number
  -p, --protocol <protocol>  Protocol to use (sacn or artnet)
  -i, --interface <name>     Network interface name to bind to
  -a, --address <ip>         IP address to bind to
  -u, --universe <number>    Universe number to monitor/playback
  -m, --multicast            Enable multicast (sACN)
  -b, --broadcast            Enable broadcast (Art-Net)
  -v, --verbose              Enable verbose logging
  -l, --log-file <path>      Write logs to file
  -o, --recording-dir <path> Directory to save recordings (default: current directory)
  --playback <file>          Play back a .dmxrec recording file
  --loop                     Enable loop mode for playback
  --speed <factor>           Playback speed multiplier (0.1 - 10.0)
  --priority <number>        sACN priority for playback (0-200, default 100)
  -h, --help                 display help for command
```

### Examples

```bash
# Monitor sACN on all interfaces with multicast
dmx-monitor -p sacn -m

# Monitor Art-Net on a specific interface
dmx-monitor -p artnet -i "Ethernet" -b

# Monitor a specific universe with verbose logging
dmx-monitor -p sacn -u 1 -m -v

# Log to file for debugging
dmx-monitor -p artnet -b -l dmx-monitor.log

# Save recordings to a specific directory
dmx-monitor -p sacn -u 1 -m -o ./recordings

# Play back a recording
dmx-monitor --playback recording.dmxrec

# Play back with loop and 2x speed
dmx-monitor --playback recording.dmxrec --loop --speed 2.0

# Play back to a specific universe with custom sACN priority
dmx-monitor --playback recording.dmxrec -u 5 --priority 150
```

## Recording and Playback

### Recording DMX Data

While monitoring, press `R` to start/stop recording. Recordings are saved as `.dmxrec` files containing:

- Protocol and universe information
- Timestamped DMX frames
- Compressed binary format for efficient storage

Recording files are saved to the current directory by default, or to the directory specified with `-o`.

### Playing Back Recordings

Use `--playback <file>` to play back a recording. The playback mode:

- Transmits DMX data via sACN or Art-Net (same protocol as recorded, or override with `-p`)
- Displays the DMX values in real-time
- Supports speed adjustment (0.1x to 10x)
- Supports looping for continuous playback
- Allows seeking forward/backward through the recording

## Display

The monitor displays a 32x16 grid representing DMX channels 1-512:

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ DMXDesktop.com - DMX Monitor - Universe 1 (SACN)                                     │
├──────────────────────────────────────────────────────────────────────────────────────┤
│      1   2   3   4   5   6   7   8   9  10  ...  │ Statistics                        │
│  1-32    0   0   0   0 255 255 128   0   0   0   │                                   │
│ 33-64    0   0   0   0   0   0   0   0   0   0   │ Protocol:  SACN                   │
│ 65-96    0   0   0   0   0   0   0   0   0   0   │ Universe:  1                      │
│   ...                                            │ Interface: 192.168.1.100          │
│                                                  │                                   │
│                                                  │ Packets:   12345                  │
│                                                  │ Rate:      44.0/s                 │
│                                                  │ Errors:    0                      │
│                                                  │ Uptime:    00:05:32               │
│                                                  │                                   │
│                                                  │ Display:   Values                 │
│                                                  │ ● REC 00:01:23                    │
│                                                  │ Frames: 2048                      │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ Q: Quit | R: Record | C: Clear | V: Toggle View                                      │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

### Color Coding

- **Red background**: Channel value 0
- **Green background**: Channel value 255
- Intermediate values show a gradient from red to green

### Keyboard Shortcuts (Monitor Mode)

- `Q` or `Ctrl+C`: Quit the application
- `R`: Toggle recording (saves to `.dmxrec` file)
- `C`: Clear all channel values to 0
- `V`: Toggle between value/channel display mode

### Keyboard Shortcuts (Playback Mode)

- `Space`: Play/Pause
- `S`: Stop (reset to beginning)
- `L`: Toggle loop mode
- `+`/`-`: Increase/decrease playback speed
- `←`/`→`: Seek backward/forward 5 seconds
- `V`: Toggle between value/channel display mode
- `Q`: Quit

## Protocol Details

### sACN (E1.31)

- Default port: 5568
- Supports multicast addressing (239.255.x.y)
- Universe range: 1-63999

### Art-Net

- Default port: 6454
- Supports broadcast mode
- Universe range: 0-32767

## Requirements

- Node.js 18.0.0 or higher
- Terminal with color support
- Minimum terminal size: 100x30 characters

## Troubleshooting

### Port Already in Use

If you see "Port XXXX is already in use", another application is using the DMX port. Close other DMX software or use a different network interface.

### No Universes Detected

- Ensure DMX traffic is being sent on the network
- Check firewall settings
- Verify you're on the correct network interface
- For sACN, ensure multicast is enabled
- For Art-Net, ensure broadcast is enabled

### Permission Denied

On some systems, binding to ports below 1024 requires elevated privileges. Both sACN (5568) and Art-Net (6454) use ports above 1024, but you may need to run with administrator privileges on Windows for network access.

## Building Executables

The project can be compiled into standalone executables using `pkg`. This bundles Node.js and all dependencies into a single file.

**Important:** The executables created by `pkg` are truly standalone - they include the Node.js runtime bundled inside, so **Node.js does NOT need to be installed** on the target machine. The executable size (~50MB) is normal because it includes the entire Node.js runtime (~30-40MB) plus your application code and dependencies.

**Note:** When you create a GitHub release, binaries are automatically built for all platforms and attached to the release via GitHub Actions.

### Build Locally

```bash
# Build for current platform
npm run pkg

# Build for Windows
npm run pkg:win

# Build for macOS
npm run pkg:mac

# Build for Linux
npm run pkg:linux

# Build for all platforms
npm run pkg:all
```

## Development

```bash
# Run in development mode (with ts-node)
npm run dev

# Build for production
npm run build

# Clean build artifacts
npm run clean
```

## License

This project is licensed under the **GNU General Public License v3.0 (GPL-3.0)** - see the [LICENSE](LICENSE) file for details.

### Third-Party Licenses

This project uses the following open-source dependencies:

| Package                                              | License    | Description                              |
| ---------------------------------------------------- | ---------- | ---------------------------------------- |
| [sacn](https://github.com/k-yle/sACN)                | Apache-2.0 | sACN (E1.31) protocol implementation     |
| [artnet](https://github.com/hobbyquaker/artnet)      | MIT        | Art-Net protocol implementation          |
| [blessed](https://github.com/chjj/blessed)           | MIT        | Terminal UI library                      |
| [commander](https://github.com/tj/commander.js)      | MIT        | Command-line argument parsing            |
| [inquirer](https://github.com/SBoudrias/Inquirer.js) | MIT        | Interactive command-line prompts         |
| [winston](https://github.com/winstonjs/winston)      | MIT        | Logging library                          |
| [chalk](https://github.com/chalk/chalk)              | MIT        | Terminal string styling                  |
| [rxjs](https://github.com/reactivex/rxjs)            | Apache-2.0 | Reactive extensions (dependency of sacn) |

All production dependencies are licensed under MIT, Apache-2.0, ISC, BSD-3-Clause, or 0BSD - all of which are compatible with GPL-3.0.

## Contributing

Contributions are welcome! Please ensure all code is properly typed and includes appropriate error handling.

By contributing to this project, you agree that your contributions will be licensed under the GPL-3.0 license.
