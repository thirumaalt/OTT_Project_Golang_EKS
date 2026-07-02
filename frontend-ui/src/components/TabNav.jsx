import React from "react";

const tabs = ["Movies", "Series", "Anime"];

export default function TabNav({ active, onChange }) {
  return (
    <div className="flex gap-6 items-center">
      {tabs.map(t => (
        <button
          key={t}
          onClick={() => onChange(t)}
          className={`text-sm font-medium transition-colors duration-200 ${active === t ? "text-white font-bold cursor-default" : "text-gray-400 hover:text-gray-200"
            }`}
        >
          {t}
        </button>
      ))}
    </div>
  );
}
