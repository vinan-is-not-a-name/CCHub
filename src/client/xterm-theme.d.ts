declare module 'xterm-theme' {
  interface XtermTheme {
    background?: string;
    foreground?: string;
    [key: string]: string | undefined;
  }
  const themes: Record<string, XtermTheme>;
  export default themes;
}
