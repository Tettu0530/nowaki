// Jetstream form events: data-live-submit sends the form's fields, data-live-input sends the value
// while typing (debounced), data-live-change fires on commit. Rows carry data-key, so the morph
// keeps each row (and its checkbox) when the list is filtered or reordered.
type Todo = { id: number; text: string; done: boolean };
type State = { todos: Todo[]; filter: string; nextId: number };

export const live = {
  state: (): State => ({ todos: [], filter: "", nextId: 1 }),
  on: {
    add: (s: State, form: { text?: string }) => {
      const text = String(form?.text ?? "").trim().slice(0, 100);
      if (!text) return s;
      return { ...s, todos: [{ id: s.nextId, text, done: false }, ...s.todos], nextId: s.nextId + 1 };
    },
    filter: (s: State, value: unknown) => ({ ...s, filter: String(value ?? "").slice(0, 100) }),
    toggle: (s: State, box: { value?: string; checked?: boolean }) => ({
      ...s,
      todos: s.todos.map((t) => (String(t.id) === String(box?.value) ? { ...t, done: Boolean(box?.checked) } : t)),
    }),
  },
};

export default function LiveTodos({ state }: { state: State }) {
  const shown = state.todos.filter((t) => t.text.toLowerCase().includes(state.filter.toLowerCase()));
  return (
    <section>
      <form data-live-submit="add">
        <input name="text" placeholder="new todo" data-testid="todo-text" />
        <button type="submit">add</button>
      </form>
      <input placeholder="filter" data-live-input="filter" data-live-debounce="100" data-testid="todo-filter" />
      <ul data-testid="todo-list">
        {shown.map((t) => (
          <li data-key={String(t.id)}>
            <label>
              <input type="checkbox" checked={t.done} data-live-change="toggle" value={String(t.id)} />
              {t.text}
            </label>
          </li>
        ))}
      </ul>
      <p data-testid="todo-count">{state.todos.length} total, filter "{state.filter}"</p>
    </section>
  );
}
