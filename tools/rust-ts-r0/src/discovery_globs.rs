#[derive(Clone)]
enum Token {
    Literal(char),
    Any,
    Star,
    Tree,
    Directories,
    Class {
        excluded: bool,
        ranges: Vec<(char, char)>,
    },
}

fn expand(pattern: &str) -> Result<Vec<String>, String> {
    let Some(start) = pattern.find('{') else {
        return Ok(vec![pattern.to_owned()]);
    };
    let mut depth = 0;
    let mut splits = vec![start + 1];
    let mut end = None;
    for (offset, ch) in pattern[start..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    end = Some(start + offset);
                    break;
                }
            }
            ',' if depth == 1 => splits.push(start + offset + 1),
            _ => {}
        }
    }
    let end = end.ok_or("DISCOVERY_INVALID_GLOB_BRACES")?;
    let mut patterns = vec![];
    for (index, begin) in splits.iter().enumerate() {
        let finish = splits.get(index + 1).map_or(end, |next| next - 1);
        for expanded in expand(&format!(
            "{}{}{}",
            &pattern[..start],
            &pattern[*begin..finish],
            &pattern[end + 1..]
        ))? {
            if patterns.len() >= 1024 {
                return Err("DISCOVERY_GLOB_EXPANSION_LIMIT".into());
            }
            patterns.push(expanded);
        }
    }
    Ok(patterns)
}

fn tokens(pattern: &str) -> Result<Vec<Token>, String> {
    let chars = pattern.chars().collect::<Vec<_>>();
    let mut result = vec![];
    let mut index = 0;
    while index < chars.len() {
        match chars[index] {
            '*' if chars.get(index + 1) == Some(&'*')
                && (index == 0 || chars[index - 1] == '/')
                && (index + 2 == chars.len() || chars.get(index + 2) == Some(&'/')) =>
            {
                if chars.get(index + 2) == Some(&'/') {
                    result.push(Token::Directories);
                    index += 3;
                } else {
                    result.push(Token::Tree);
                    index += 2;
                }
            }
            '*' => {
                result.push(Token::Star);
                index += 1;
            }
            '?' => {
                result.push(Token::Any);
                index += 1;
            }
            '[' => {
                index += 1;
                let excluded = matches!(chars.get(index), Some('!') | Some('^'));
                if excluded {
                    index += 1;
                }
                let mut ranges = vec![];
                while index < chars.len() && chars[index] != ']' {
                    let first = chars[index];
                    index += 1;
                    let last = if chars.get(index) == Some(&'-')
                        && chars.get(index + 1).is_some_and(|ch| *ch != ']')
                    {
                        index += 2;
                        chars[index - 1]
                    } else {
                        first
                    };
                    if first > last || first == '/' || last == '/' {
                        return Err("DISCOVERY_INVALID_GLOB_CLASS".into());
                    }
                    ranges.push((first, last));
                }
                if ranges.is_empty() || chars.get(index) != Some(&']') {
                    return Err("DISCOVERY_INVALID_GLOB_CLASS".into());
                }
                index += 1;
                result.push(Token::Class { excluded, ranges });
            }
            '(' | ')' | '!' | '+' | '@'
                if chars.get(index + 1) == Some(&'(') || matches!(chars[index], '(' | ')') =>
            {
                return Err("DISCOVERY_UNSUPPORTED_GLOB_EXTGROUP".into());
            }
            ch => {
                result.push(Token::Literal(ch));
                index += 1;
            }
        }
    }
    Ok(result)
}

fn matches(tokens: &[Token], text: &[char]) -> bool {
    let mut current = vec![false; text.len() + 1];
    current[0] = true;
    for token in tokens {
        let mut next = vec![false; text.len() + 1];
        for index in 0..=text.len() {
            if !current[index] {
                continue;
            }
            match token {
                Token::Tree => next[index..].fill(true),
                Token::Directories => {
                    next[index] = true;
                    for (pos, _) in text
                        .iter()
                        .enumerate()
                        .skip(index)
                        .filter(|(_, ch)| **ch == '/')
                    {
                        next[pos + 1] = true;
                    }
                }
                Token::Star => {
                    let end = text[index..]
                        .iter()
                        .position(|ch| *ch == '/')
                        .map_or(text.len(), |offset| index + offset);
                    next[index..=end].fill(true);
                }
                _ if index < text.len() => {
                    let ch = text[index];
                    next[index + 1] |= match token {
                        Token::Literal(expected) => *expected == ch,
                        Token::Any => ch != '/',
                        Token::Class { excluded, ranges } => {
                            ch != '/'
                                && (ranges.iter().any(|(a, b)| *a <= ch && ch <= *b) != *excluded)
                        }
                        _ => false,
                    };
                }
                _ => {}
            }
        }
        current = next;
    }
    current[text.len()]
}

pub(super) struct Globs(Vec<(bool, Vec<Token>)>);
impl Globs {
    pub(super) fn new(patterns: &[String]) -> Result<Self, String> {
        let mut compiled = vec![];
        for pattern in patterns {
            let normalized = pattern.replace('\\', "/");
            if normalized.len() > 4096 {
                return Err("DISCOVERY_GLOB_LENGTH_LIMIT".into());
            }
            let count = normalized.chars().take_while(|ch| *ch == '!').count();
            let negated = count % 2 == 1;
            for expanded in expand(&normalized[count..])? {
                compiled.push((negated, tokens(&expanded)?));
            }
            if compiled.len() > 1024 {
                return Err("DISCOVERY_GLOB_EXPANSION_LIMIT".into());
            }
        }
        Ok(Self(compiled))
    }
    pub(super) fn matches(&self, path: &str) -> bool {
        let text = path.chars().collect::<Vec<_>>();
        self.0
            .iter()
            .any(|(negated, pattern)| matches(pattern, &text) != *negated)
    }
}

#[cfg(test)]
#[path = "../tests/unit/discovery_globs.rs"]
mod tests;
