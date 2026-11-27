import type { PluginClientContext } from "@getpaseo/plugin/client";
import { CoordinatorScreen, CoordinatorSettingsScreen } from "./client/coordinator-screen";
import { messages } from "./client/i18n";
import { CoordinatorSidebarItem, SCREEN_ID } from "./client/sidebar-item";

export default function contribute(client: PluginClientContext) {
  const title = messages.message("app.title");
  const removers = [
    client.addScreen({ id: SCREEN_ID, title, Component: CoordinatorScreen }),
    client.addSidebarHeaderItem({ id: SCREEN_ID, title, Component: CoordinatorSidebarItem }),
    client.addSettingsScreen({
      id: "settings",
      title,
      icon: "LayoutDashboard",
      Component: CoordinatorSettingsScreen,
    }),
  ];
  return () => {
    for (const remove of removers) void remove();
  };
}
