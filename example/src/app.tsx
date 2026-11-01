import { greet } from "./util.ts";

function Counter({ start }: { start: number }) {
  let count = start;
  const button = document.createElement("button");
  const render = () => (button.textContent = greet("clicks") + count);
  button.onclick = () => { count++; render(); };
  render();
  return button;
}

document.body.append(Counter({ start: 0 }));
