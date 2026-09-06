testthat::test_that("Markdown unknown wrappers cannot retain active HTML", {
  html <- render_markdown_fragment(c(
    '# <section onclick="alert(1)" style="position:fixed">',
    "# Before<strong> safe </strong><script>B138_SCRIPT_MARKER</script>",
    '# <input autofocus onfocus="alert(1)" value="secret">',
    '# <form action="https://example.invalid/"><button formaction="javascript:alert(1)">Go</button></form>',
    '# <aside srcdoc="bad"><iframe srcdoc="bad">B138_FRAME_MARKER</iframe>After</aside>',
    "# </section>"
  ))
  doc <- xml2::read_html(html)
  testthat::expect_length(xml2::xml_find_all(doc,
    "//script|//iframe|//input|//form|//button|//aside"), 0L)
  testthat::expect_length(xml2::xml_find_all(doc, "//section/@*"), 0L)
  visible <- xml2::xml_text(xml2::xml_find_first(doc, "//body"))
  testthat::expect_identical(trimws(gsub("[[:space:]]+", " ", visible)),
                             "Before safe Go After")
  testthat::expect_false(grepl("B138_SCRIPT_MARKER|B138_FRAME_MARKER", visible))
})

testthat::test_that("Markdown removes attributes from standalone unknown elements", {
  html <- sanitize_markdown_html(paste0(
    '<div onclick="alert(1)" style="position:fixed">Visible &lt;tag&gt;</div>',
    '<input autofocus onfocus="alert(1)" value="secret">',
    '<form action="https://example.invalid/"><button>Go</button></form>'
  ))
  doc <- xml2::read_html(html)
  testthat::expect_length(xml2::xml_find_all(doc,
    "//div/@*|//input/@*|//form/@*"), 0L)
  testthat::expect_length(xml2::xml_find_all(doc, "//button|//tag"), 0L)
  testthat::expect_identical(xml2::xml_text(xml2::xml_find_first(doc, "//div")),
                             "Visible <tag>")
  testthat::expect_identical(xml2::xml_text(xml2::xml_find_first(doc, "//form")),
                             "Go")
})

testthat::test_that("Markdown retains ordinary safe content and link restrictions", {
  html <- sanitize_markdown_html(paste0(
    "<p>Before <strong>bold</strong> and <em>emphasis</em>.</p>",
    '<pre><code class="language-r">x &lt;- 1</code></pre>',
    '<a href="https://example.invalid/help" title="Help">safe</a>',
    '<a href="javascript:alert(1)">unsafe</a>',
    '<a href="%6Aavascript:alert(1)">encoded</a>'
  ))
  doc <- xml2::read_html(html)
  testthat::expect_identical(xml2::xml_text(xml2::xml_find_first(doc, "//strong")),
                             "bold")
  testthat::expect_identical(xml2::xml_text(xml2::xml_find_first(doc, "//em")),
                             "emphasis")
  code <- xml2::xml_find_first(doc, "//code")
  testthat::expect_identical(xml2::xml_text(code), "x <- 1")
  testthat::expect_identical(xml2::xml_attr(code, "class"), "language-r")
  links <- xml2::xml_find_all(doc, "//a")
  testthat::expect_identical(xml2::xml_attr(links, "href"),
    c("https://example.invalid/help", NA_character_, NA_character_))
})
