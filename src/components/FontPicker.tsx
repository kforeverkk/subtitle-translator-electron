import { useState } from "react";
import { ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

type LocalFontData = {
  family: string;
};

type LocalFontWindow = Window & {
  queryLocalFonts?: () => Promise<LocalFontData[]>;
};

type FontPickerProps = {
  id: string;
  value: string;
  onValueChange: (value: string) => void;
  placeholder: string;
  useDefaultLabel: string;
  searchPlaceholder: string;
  loadingLabel: string;
  emptyLabel: string;
  unavailableLabel: string;
};

type FontStatus = "idle" | "loading" | "ready" | "empty" | "unavailable";

function isValidAssFontName(value: string): boolean {
  return value.length <= 100 && !/[,{}\\\r\n]/.test(value);
}

export default function FontPicker({
  id,
  value,
  onValueChange,
  placeholder,
  useDefaultLabel,
  searchPlaceholder,
  loadingLabel,
  emptyLabel,
  unavailableLabel,
}: FontPickerProps) {
  const [open, setOpen] = useState(false);
  const [fonts, setFonts] = useState<string[]>([]);
  const [fontStatus, setFontStatus] = useState<FontStatus>("idle");
  const [search, setSearch] = useState("");

  const selectFont = (font: string) => {
    onValueChange(font);
    setOpen(false);
    setSearch("");
  };

  const loadFonts = () => {
    const localFontWindow = window as LocalFontWindow;
    if (!localFontWindow.queryLocalFonts) {
      setFontStatus("unavailable");
      return;
    }

    setFontStatus("loading");
    void localFontWindow.queryLocalFonts()
      .then((localFonts) => {
        const families = [...new Set(
          localFonts
            .map((font) => font.family.trim())
            .filter((font) => font.length > 0 && isValidAssFontName(font)),
        )].sort((left, right) => left.localeCompare(right));

        setFonts(families);
        setFontStatus(families.length === 0 ? "empty" : "ready");
      })
      .catch(() => {
        setFontStatus("unavailable");
      });
  };

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);

    if (nextOpen && fontStatus === "idle") {
      // This must run directly from opening the popover so browsers can show
      // the Local Font Access permission prompt as part of a user gesture.
      loadFonts();
    }
  };

  const customFont = search.trim();
  const canUseCustomFont =
    customFont.length > 0 && isValidAssFontName(customFont);
  const hasMatchingFont = fonts.some(
    (font) => font.localeCompare(customFont, undefined, { sensitivity: "accent" }) === 0,
  );

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal"
        >
          <span className="truncate" style={value ? { fontFamily: value } : undefined}>
            {value || placeholder}
          </span>
          <ChevronsUpDown className="ml-2 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) p-0" align="start">
        <Command shouldFilter={fontStatus === "ready"}>
          <CommandInput
            value={search}
            onValueChange={setSearch}
            placeholder={searchPlaceholder}
            disabled={fontStatus === "loading"}
            maxLength={100}
          />
          <CommandList>
            {fontStatus === "loading" && (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                {loadingLabel}
              </div>
            )}
            {fontStatus === "unavailable" && (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                {unavailableLabel}
              </div>
            )}
            {fontStatus === "empty" && (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                {emptyLabel}
              </div>
            )}
            {fontStatus !== "loading" && (
              <CommandGroup>
                <CommandItem
                  value="use-subtitle-style"
                  data-checked={!value}
                  onSelect={() => selectFont("")}
                >
                  {useDefaultLabel}
                </CommandItem>
                {canUseCustomFont && !hasMatchingFont && (
                  <CommandItem
                    value={customFont}
                    data-checked={value === customFont}
                    onSelect={() => selectFont(customFont)}
                  >
                    <span className="truncate" style={{ fontFamily: customFont }}>
                      {customFont}
                    </span>
                  </CommandItem>
                )}
                {fontStatus === "ready" && fonts.map((font) => (
                  <CommandItem
                    key={font}
                    value={font}
                    data-checked={value === font}
                    onSelect={() => selectFont(font)}
                  >
                    <span className="truncate" style={{ fontFamily: font }}>
                      {font}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {fontStatus === "ready" && <CommandEmpty>{emptyLabel}</CommandEmpty>}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
