use std::{env, fs, process::ExitCode, time::Instant};
use syn::{spanned::Spanned, visit::Visit, Attribute, Expr, Item, Lit, Meta};

fn main() -> ExitCode {
    match run() {
        Ok(output) => {
            print!("{output}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<String, String> {
    let paths = env::args_os().skip(1).collect::<Vec<_>>();
    if paths.len() != 1 {
        return Err("usage: semctx-rust-syn-probe FILE.rs".into());
    }
    let source = fs::read_to_string(&paths[0]).map_err(|error| format!("read: {error}"))?;
    let started = Instant::now();
    let file = syn::parse_file(&source).map_err(|error| format!("parse: {error}"))?;
    eprintln!("timing\tparse_ns\t{}", started.elapsed().as_nanos());
    let mut counter = Counter::default();
    counter.visit_file(&file);
    let mut output = format!(
        "summary\titems\t{}\tmethods\t{}\n",
        counter.items, counter.methods
    );
    for item in &file.items {
        let Some((kind, name, attributes)) = symbol(item) else {
            continue;
        };
        let span = item.span();
        let start = source_offset(&source, span.start().line, span.start().column)?;
        let end = source_offset(&source, span.end().line, span.end().column)?;
        output.push_str(&format!(
            "symbol\t{kind}\t{name}\t{start}\t{end}\t{}\n",
            attribute_labels(attributes)
                .replace('\\', "\\\\")
                .replace('\t', "\\t")
                .replace('\r', "\\r")
                .replace('\n', "\\n")
        ));
    }
    Ok(output)
}

#[derive(Default)]
struct Counter {
    items: usize,
    methods: usize,
}

impl<'ast> Visit<'ast> for Counter {
    fn visit_item(&mut self, item: &'ast Item) {
        self.items += 1;
        syn::visit::visit_item(self, item);
    }

    fn visit_impl_item_fn(&mut self, method: &'ast syn::ImplItemFn) {
        self.methods += 1;
        syn::visit::visit_impl_item_fn(self, method);
    }

    fn visit_trait_item_fn(&mut self, method: &'ast syn::TraitItemFn) {
        self.methods += 1;
        syn::visit::visit_trait_item_fn(self, method);
    }
}

fn symbol(item: &Item) -> Option<(&'static str, String, &[Attribute])> {
    match item {
        Item::Fn(item) => Some(("fn", item.sig.ident.to_string(), &item.attrs)),
        Item::Struct(item) => Some(("struct", item.ident.to_string(), &item.attrs)),
        Item::Enum(item) => Some(("enum", item.ident.to_string(), &item.attrs)),
        Item::Trait(item) => Some(("trait", item.ident.to_string(), &item.attrs)),
        Item::Type(item) => Some(("type", item.ident.to_string(), &item.attrs)),
        Item::Const(item) => Some(("const", item.ident.to_string(), &item.attrs)),
        Item::Static(item) => Some(("static", item.ident.to_string(), &item.attrs)),
        Item::Mod(item) => Some(("mod", item.ident.to_string(), &item.attrs)),
        Item::Impl(item) => Some(("impl", "_".into(), &item.attrs)),
        Item::Use(item) => Some(("use", "_".into(), &item.attrs)),
        Item::Macro(item) => Some((
            "macro",
            item.ident
                .as_ref()
                .map(ToString::to_string)
                .unwrap_or_else(|| "_".into()),
            &item.attrs,
        )),
        _ => None,
    }
}

fn attribute_labels(attributes: &[Attribute]) -> String {
    attributes
        .iter()
        .map(|attribute| {
            let name = attribute
                .path()
                .segments
                .iter()
                .map(|segment| segment.ident.to_string())
                .collect::<Vec<_>>()
                .join("::");
            if let Meta::NameValue(meta) = &attribute.meta {
                if let Expr::Lit(expression) = &meta.value {
                    if let Lit::Str(value) = &expression.lit {
                        return format!("{name}={}", value.value());
                    }
                }
            }
            name
        })
        .collect::<Vec<_>>()
        .join(",")
}

fn source_offset(source: &str, line: usize, column: usize) -> Result<usize, String> {
    let source_without_bom = source.strip_prefix('\u{feff}').unwrap_or(source);
    let mut offset = source.len() - source_without_bom.len();
    for (index, raw) in source_without_bom.split('\n').enumerate() {
        if index + 1 != line {
            offset += raw.len() + 1;
            continue;
        }
        let content = raw.strip_suffix('\r').unwrap_or(raw);
        if column == content.chars().count() {
            return Ok(offset + content.len());
        }
        return content
            .char_indices()
            .nth(column)
            .map(|(byte, _)| offset + byte)
            .ok_or_else(|| format!("range: invalid column {column} on line {line}"));
    }
    Err(format!("range: invalid line {line}"))
}

#[cfg(test)]
mod tests {
    use super::source_offset;

    #[test]
    fn translates_scalar_columns_into_utf8_bytes_across_lf_and_crlf() {
        let source = "éx\r\nλ\nz";
        assert_eq!(source_offset(source, 1, 1).unwrap(), 2);
        assert_eq!(source_offset(source, 1, 2).unwrap(), 3);
        assert_eq!(source_offset(source, 2, 1).unwrap(), 7);
        assert_eq!(source_offset(source, 3, 0).unwrap(), 8);
    }

    #[test]
    fn rejects_lines_and_columns_outside_source() {
        assert!(source_offset("é\r\n", 0, 0).is_err());
        assert!(source_offset("é\r\n", 1, 2).is_err());
        assert!(source_offset("é\r\n", 3, 0).is_err());
        assert_eq!(source_offset("é\r\n", 2, 0).unwrap(), 4);
    }
}
