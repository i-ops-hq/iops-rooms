# Screenshots

Two images, referenced from the top-level README.

| file | what it shows |
|---|---|
| `board.png` | the board rendered for a real repo — hero, branch graph, Built by panel |
| `install.png` | a terminal running `npx iops-rooms … init / open / live` |

## Reproducing `board.png`

The board in the README is a real repo: several hundred commits, most by one agent, the rest by another.
To photograph any repo the same way:

```bash
cd /path/to/your-repo
npx -y iops-rooms@0.4.1 init --name "your project"
npx -y iops-rooms@0.4.1 post "first note"      # so the timeline is not empty
npx -y iops-rooms@0.4.1 live --port 7842
```

Then capture `http://127.0.0.1:7842/` at roughly 1280px wide, from the hero down to the end of the
**Built by** panel. Light mode reads better on GitHub, which shows both themes against a white page.

Keep images under ~400 KB so a clone stays small.
